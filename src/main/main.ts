import { app, BrowserWindow, ipcMain, clipboard, globalShortcut, Tray, Menu, nativeImage, screen, systemPreferences, shell, dialog, session } from 'electron';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { autoUpdater } from 'electron-updater';
import electronLog from 'electron-log';
import { initAnalytics, trackEvent, startHeartbeat, stopHeartbeat } from '../lib/analytics';
import { getDisplayBounds, isPositionValid } from './window-position';
import type { WindowPosition } from './window-position';
import { captureCurrentClipboard, addTranscriptionToHistory, restoreClipboardEntry, getClipboardHistory, getEntryLabel, snapshotClipboard, restoreSnapshot, type ClipboardEntry } from './clipboard-history';
import { loadTranscriptHistory, addTranscriptToHistory, getRecentTranscripts } from './transcript-history';
import { loadStats, recordTranscription, getStatsWithDerived, resetStats } from './stats';
import { startKeyboardHook, stopKeyboardHook } from './keyboard-hook';
import { startWakeWord, stopWakeWord, listAvailableModels as listWakeWordModels, customModelsDir as wakeWordCustomDir } from './wake-word';
import { ParakeetService, type ParakeetStatus } from './parakeet-service';
import type { AppSettings } from '../shared/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dev server port - must match VITE_PORT in vite.config.ts (default: 12000)
const DEV_PORT = parseInt(process.env.VITE_PORT || '12000', 10);
const IS_LOCAL_DEV_BUILD = process.env.LOCAL_DEV_BUILD === 'true';

// Ensure single instance of the application
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running, quit immediately
  app.quit();
} else {
  // This is the first instance - register handler for when another instance tries to start
  app.on('second-instance', () => {
    // Someone tried to run a second instance, focus our window instead
    if (mainWindow) {
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
      mainWindow.focus();
    }
  });
}

// Configure electron-log
// Logs go to: ~/Library/Logs/Nerd Dictum/main.log (macOS)
// Also visible in Console.app and terminal
electronLog.transports.file.level = 'info';
electronLog.transports.console.level = 'info';

// Wrapper function for consistent logging interface
function log(...args: unknown[]): void {
  electronLog.info(...args);
}

// Track original volume level before recording
let savedVolume: number | null = null;
const RECORDING_VOLUME = 10; // Lower volume to 10% during recording

// Lower system volume during recording (macOS)
function pauseMediaPlayback(): void {
  if (process.platform !== 'darwin') return;

  // Get current volume and lower it
  exec(`osascript -e 'output volume of (get volume settings)'`, (error, stdout) => {
    if (error) {
      log('[Media] Error getting volume:', error.message);
      return;
    }

    const currentVolume = parseInt(stdout.trim(), 10);
    if (isNaN(currentVolume)) {
      log('[Media] Could not parse volume:', stdout);
      return;
    }

    // Only save and lower if volume is above our recording threshold
    if (currentVolume > RECORDING_VOLUME) {
      savedVolume = currentVolume;
      exec(`osascript -e 'set volume output volume ${RECORDING_VOLUME}'`, (err) => {
        if (err) {
          log('[Media] Error setting volume:', err.message);
          savedVolume = null;
          return;
        }
        log('[Media] Volume lowered from', currentVolume, 'to', RECORDING_VOLUME);
      });
    } else {
      log('[Media] Volume already low:', currentVolume);
    }
  });
}

// Restore system volume after recording (macOS)
function resumeMediaPlayback(): void {
  if (process.platform !== 'darwin') return;
  if (savedVolume === null) return;

  const volumeToRestore = savedVolume;
  savedVolume = null;

  exec(`osascript -e 'set volume output volume ${volumeToRestore}'`, (error) => {
    if (error) {
      log('[Media] Error restoring volume:', error.message);
      return;
    }
    log('[Media] Volume restored to', volumeToRestore);
  });
}

const DEFAULT_HOTKEY = 'CommandOrControl+Shift+R';

const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  model: 'gemini-3-flash-preview',
  languages: ['en', 'he'],
  speechDomain: 'programming',
  customDomainHint: '',
  customKeywords: '',
  microphoneDeviceId: '',
  silenceDetectionEnabled: true,
  silenceDurationMs: 2500,
  launchAtStartup: false,
  clarificationEnabled: true,
  previousTranscriptContextEnabled: true,
  soundEnabled: true,
  hotkey: DEFAULT_HOTKEY,
  widgetHidden: false,
  holdToRecordEnabled: true,
  holdToRecordKey: 'LeftAlt',
  autoPasteEnabled: true,
  wakeWordEnabled: false,
  wakeWordKeyword: 'hey_jarvis',
  wakeWordThreshold: 0.5,
  wakeWordPressEnter: true,
  transcriptionMode: 'gemini',
};

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings(): AppSettings {
  try {
    const settingsPath = getSettingsPath();
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf-8');
      const parsed = JSON.parse(data);
      const settings = { ...DEFAULT_SETTINGS, ...parsed };
      // Sync launchAtStartup with actual system state
      const { openAtLogin } = app.getLoginItemSettings();
      settings.launchAtStartup = openAtLogin;
      return settings;
    }
  } catch (error) {
    log('[Settings] Failed to load settings:', error);
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings: AppSettings): boolean {
  try {
    const settingsPath = getSettingsPath();
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    // Apply auto-launch setting to system
    app.setLoginItemSettings({
      openAtLogin: settings.launchAtStartup,
      openAsHidden: true, // macOS: launch without focusing
    });
    return true;
  } catch (error) {
    log('[Settings] Failed to save:', error);
    return false;
  }
}

let appSettings: AppSettings = DEFAULT_SETTINGS;

const parakeetService = new ParakeetService(log);
parakeetService.onStatusChange((status: ParakeetStatus) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('parakeet-status-change', status);
  }
});

// Window position persistence
function getWindowPositionPath(): string {
  return path.join(app.getPath('userData'), 'window-position.json');
}

function loadWindowPosition(): WindowPosition | null {
  try {
    const positionPath = getWindowPositionPath();
    if (fs.existsSync(positionPath)) {
      const data = fs.readFileSync(positionPath, 'utf-8');
      const parsed = JSON.parse(data) as WindowPosition;
      const displays = screen.getAllDisplays();
      const isValidPosition = isPositionValid(
        parsed,
        displays.length,
        getDisplayBounds(displays)
      );
      log('[WindowPosition] Validation:', {
        displayCount: displays.length,
        isValid: isValidPosition,
      });

      if (!isValidPosition) {
        return null;
      }

      return parsed;
    }
  } catch (error) {
    log('[WindowPosition] Failed to load position:', error);
  }
  return null;
}

function saveWindowPosition(x: number, y: number): void {
  try {
    const displayCount = screen.getAllDisplays().length;
    const position: WindowPosition = { x, y, displayCount };
    const positionPath = getWindowPositionPath();
    fs.writeFileSync(positionPath, JSON.stringify(position, null, 2), 'utf-8');
  } catch (error) {
    log('[WindowPosition] Failed to save position:', error);
  }
}

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let infoWindow: BrowserWindow | null = null;
let hideWindow: BrowserWindow | null = null;
let statsWindow: BrowserWindow | null = null;
let errorDetailWindow: BrowserWindow | null = null;
let pendingErrorDetail: { message: string; statusCode?: number; responseBody?: string } | null = null;
let tray: Tray | null = null;
let hideTimer: NodeJS.Timeout | null = null;

async function updateDockVisibility() {
  if (process.platform !== 'darwin' || !app.dock) return;

  const hasSecondaryWindows =
    (settingsWindow && !settingsWindow.isDestroyed()) ||
    (infoWindow && !infoWindow.isDestroyed()) ||
    (hideWindow && !hideWindow.isDestroyed()) ||
    (statsWindow && !statsWindow.isDestroyed()) ||
    (errorDetailWindow && !errorDetailWindow.isDestroyed());

  if (hasSecondaryWindows) {
    // Show dock first, then set icon (setIcon requires dock to be visible)
    await app.dock.show();
    const appIconPath = getAppIconPath();
    const appIcon = nativeImage.createFromPath(appIconPath);
    if (!appIcon.isEmpty()) {
      app.dock.setIcon(appIcon);
    }
  } else {
    app.dock.hide();
  }
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  // Get the display where the main window is located
  let windowBounds: { x: number; y: number; width: number; height: number } | undefined;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const mainBounds = mainWindow.getBounds();
    const display = screen.getDisplayNearestPoint({ x: mainBounds.x, y: mainBounds.y });
    const { workArea } = display;
    // Center the settings window on the same display
    const width = 500;
    const height = 700;
    windowBounds = {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width,
      height,
    };
  }

  settingsWindow = new BrowserWindow({
    width: 500,
    height: 700,
    ...(windowBounds && { x: windowBounds.x, y: windowBounds.y }),
    frame: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Nerd Dictum — Settings',
    modal: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isDev = isRendererDevMode();

  if (isDev) {
    settingsWindow.loadURL(`http://localhost:${DEV_PORT}/settings.html`);
  } else {
    settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'));
  }

  settingsWindow.once('ready-to-show', () => {
    settingsWindow?.show();
    updateDockVisibility();
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
    updateDockVisibility();
  });
}

function createInfoWindow() {
  if (infoWindow && !infoWindow.isDestroyed()) {
    infoWindow.focus();
    return;
  }

  // Get the display where the main window is located
  let windowBounds: { x: number; y: number; width: number; height: number } | undefined;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const mainBounds = mainWindow.getBounds();
    const display = screen.getDisplayNearestPoint({ x: mainBounds.x, y: mainBounds.y });
    const { workArea } = display;
    // Center the info window on the same display
    const width = 400;
    const height = 580;
    windowBounds = {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width,
      height,
    };
  }

  infoWindow = new BrowserWindow({
    width: 400,
    height: 580,
    ...(windowBounds && { x: windowBounds.x, y: windowBounds.y }),
    frame: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Nerd Dictum — How to Use',
    modal: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isDev = isRendererDevMode();

  if (isDev) {
    infoWindow.loadURL(`http://localhost:${DEV_PORT}/info.html`);
  } else {
    infoWindow.loadFile(path.join(__dirname, '../renderer/info.html'));
  }

  infoWindow.once('ready-to-show', () => {
    infoWindow?.show();
    updateDockVisibility();
  });

  infoWindow.on('closed', () => {
    infoWindow = null;
    updateDockVisibility();
  });
}

function createHideWindow() {
  if (hideWindow && !hideWindow.isDestroyed()) {
    hideWindow.focus();
    return;
  }

  // Get the display where the main window is located
  let windowBounds: { x: number; y: number; width: number; height: number } | undefined;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const mainBounds = mainWindow.getBounds();
    const display = screen.getDisplayNearestPoint({ x: mainBounds.x, y: mainBounds.y });
    const { workArea } = display;
    // Center the hide window on the same display
    const width = 260;
    const height = 260;
    windowBounds = {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width,
      height,
    };
  }

  hideWindow = new BrowserWindow({
    width: 260,
    height: 260,
    ...(windowBounds && { x: windowBounds.x, y: windowBounds.y }),
    frame: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Nerd Dictum — Hide Widget',
    modal: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isDev = isRendererDevMode();

  if (isDev) {
    hideWindow.loadURL(`http://localhost:${DEV_PORT}/hide.html`);
  } else {
    hideWindow.loadFile(path.join(__dirname, '../renderer/hide.html'));
  }

  hideWindow.once('ready-to-show', () => {
    hideWindow?.show();
    updateDockVisibility();
  });

  hideWindow.on('closed', () => {
    hideWindow = null;
    updateDockVisibility();
  });
}

function createStatsWindow() {
  if (statsWindow && !statsWindow.isDestroyed()) {
    statsWindow.focus();
    return;
  }

  // Get the display where the main window is located
  let windowBounds: { x: number; y: number; width: number; height: number } | undefined;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const mainBounds = mainWindow.getBounds();
    const display = screen.getDisplayNearestPoint({ x: mainBounds.x, y: mainBounds.y });
    const { workArea } = display;
    // Center the stats window on the same display
    const width = 420;
    const height = 720;
    windowBounds = {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width,
      height,
    };
  }

  statsWindow = new BrowserWindow({
    width: 420,
    height: 720,
    ...(windowBounds && { x: windowBounds.x, y: windowBounds.y }),
    frame: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Nerd Dictum — Statistics',
    modal: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isDev = isRendererDevMode();

  if (isDev) {
    statsWindow.loadURL(`http://localhost:${DEV_PORT}/stats.html`);
  } else {
    statsWindow.loadFile(path.join(__dirname, '../renderer/stats.html'));
  }

  statsWindow.once('ready-to-show', () => {
    statsWindow?.show();
    updateDockVisibility();
  });

  statsWindow.on('closed', () => {
    statsWindow = null;
    updateDockVisibility();
  });
}

function createErrorDetailWindow() {
  if (errorDetailWindow && !errorDetailWindow.isDestroyed()) {
    errorDetailWindow.focus();
    return;
  }

  // Get the display where the main window is located
  let windowBounds: { x: number; y: number; width: number; height: number } | undefined;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const mainBounds = mainWindow.getBounds();
    const display = screen.getDisplayNearestPoint({ x: mainBounds.x, y: mainBounds.y });
    const { workArea } = display;
    const width = 560;
    const height = 440;
    windowBounds = {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width,
      height,
    };
  }

  errorDetailWindow = new BrowserWindow({
    width: 560,
    height: 440,
    ...(windowBounds && { x: windowBounds.x, y: windowBounds.y }),
    frame: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    title: 'Nerd Dictum — API Error',
    modal: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isDev = isRendererDevMode();

  if (isDev) {
    errorDetailWindow.loadURL(`http://localhost:${DEV_PORT}/error-detail.html`);
  } else {
    errorDetailWindow.loadFile(path.join(__dirname, '../renderer/error-detail.html'));
  }

  errorDetailWindow.once('ready-to-show', () => {
    errorDetailWindow?.show();
    updateDockVisibility();
  });

  errorDetailWindow.on('closed', () => {
    errorDetailWindow = null;
    pendingErrorDetail = null;
    updateDockVisibility();
  });
}

function createWindow() {
  // Try to restore saved window position
  const savedPosition = loadWindowPosition();

  mainWindow = new BrowserWindow({
    width: 80,
    height: 100,
    ...(savedPosition && { x: savedPosition.x, y: savedPosition.y }),
    frame: false,
    transparent: false,
    backgroundColor: '#2a2a2a',
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // macOS: ensure window stays visible on all Spaces
  if (process.platform === 'darwin') {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  // Use ELECTRON_DEV env var to detect dev mode, or fall back to app.isPackaged
  const isDev = isRendererDevMode();

  if (isDev) {
    mainWindow.loadURL(`http://localhost:${DEV_PORT}`);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Save window position when moved
  mainWindow.on('move', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const [x, y] = mainWindow.getPosition();
      saveWindowPosition(x, y);
    }
  });

  // Hide to tray instead of closing on macOS/Windows
  mainWindow.on('close', (event) => {
    if (tray && !(app as any).isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    // Close child windows when main window is closed
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.close();
    }
    if (infoWindow && !infoWindow.isDestroyed()) {
      infoWindow.close();
    }
    mainWindow = null;
  });
}

function getIconPath(): string {
  // Use Template suffix on macOS for proper menu bar appearance
  const iconName = process.platform === 'darwin' ? 'tray-iconTemplate.png' : 'tray-icon.png';

  if (!app.isPackaged) {
    // In development, assets are in project root
    return path.join(app.getAppPath(), 'assets', iconName);
  } else {
    // In production, assets are in resources folder
    return path.join(process.resourcesPath, 'assets', iconName);
  }
}

function getAppIconPath(): string {
  if (!app.isPackaged) {
    // In development, use the icon from build folder
    return path.join(app.getAppPath(), 'build', 'icon.png');
  } else {
    // In production, electron-builder handles this automatically
    return path.join(process.resourcesPath, 'icon.png');
  }
}

function createTray() {
  const iconPath = getIconPath();
  let icon = nativeImage.createFromPath(iconPath);

  // If icon failed to load, create a simple 16x16 icon programmatically
  if (icon.isEmpty()) {
    // Create a simple 16x16 white circle on transparent background
    const size = 16;
    const canvas = Buffer.alloc(size * size * 4); // RGBA
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        const cx = size / 2, cy = size / 2, r = 6;
        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        if (dist <= r) {
          canvas[idx] = 255;     // R
          canvas[idx + 1] = 255; // G
          canvas[idx + 2] = 255; // B
          canvas[idx + 3] = 255; // A
        } else {
          canvas[idx + 3] = 0;   // Transparent
        }
      }
    }
    icon = nativeImage.createFromBuffer(canvas, { width: size, height: size });
  }

  // Mark as template image on macOS for proper dark/light mode handling
  if (process.platform === 'darwin') {
    icon.setTemplateImage(true);
  }

  tray = new Tray(icon);
  updateTrayTooltip();

  updateTrayMenu();
}

// Convert Electron accelerator to human-readable format
function formatHotkeyForDisplay(hotkey: string): string {
  const isMac = process.platform === 'darwin';

  return hotkey
    .replace(/CommandOrControl/g, isMac ? '⌘' : 'Ctrl')
    .replace(/Command/g, '⌘')
    .replace(/Control/g, isMac ? '⌃' : 'Ctrl')
    .replace(/Alt/g, isMac ? '⌥' : 'Alt')
    .replace(/Shift/g, isMac ? '⇧' : 'Shift')
    .replace(/\+/g, '');
}

function updateTrayTooltip() {
  if (!tray) return;
  const hotkey = appSettings.hotkey || DEFAULT_HOTKEY;
  const displayHotkey = formatHotkeyForDisplay(hotkey);
  tray.setToolTip(`Nerd Dictum — ${displayHotkey} to record`);
}

function updateTrayMenu() {
  if (!tray) return;

  const isVisible = mainWindow?.isVisible() ?? false;

  const isDevToolsOpen = mainWindow?.webContents.isDevToolsOpened() ?? false;

  // Build update menu items
  const updateMenuItems: Electron.MenuItemConstructorOptions[] = [];
  if (!IS_LOCAL_DEV_BUILD && updateDownloaded && downloadedVersion) {
    updateMenuItems.push({
      label: `Install Update (v${downloadedVersion})`,
      click: () => {
        installUpdate();
      },
    });
  } else if (!IS_LOCAL_DEV_BUILD) {
    updateMenuItems.push({
      label: 'Check for Updates',
      click: () => {
        checkForUpdates();
      },
    });
  }

  const extraMenuItems: Electron.MenuItemConstructorOptions[] = IS_LOCAL_DEV_BUILD
    ? []
    : [{ type: 'separator' }, ...updateMenuItems];

  // Build clipboard history submenu
  const clipboardHistory = getClipboardHistory();
  const clipboardSubmenu: Electron.MenuItemConstructorOptions[] = clipboardHistory.length > 0
    ? clipboardHistory.map((entry, index) => ({
        label: getEntryLabel(entry),
        click: () => {
          restoreClipboardEntry(entry.id);
          log('[Clipboard] Restored entry:', entry.id);
        },
        // Add keyboard accelerator for first item (previous clipboard)
        ...(index === 0 ? { accelerator: 'CommandOrControl+Shift+V' } : {}),
      }))
    : [{ label: 'No history', enabled: false }];

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Nerd Dictum ${getDisplayVersion() === 'dev' ? 'dev' : `v${getDisplayVersion()}`}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: isVisible ? 'Hide Widget' : 'Show Widget',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isVisible()) {
            mainWindow.hide();
          } else {
            // Clear hide timer when manually showing
            if (hideTimer) {
              clearTimeout(hideTimer);
              hideTimer = null;
              log('[Hide] Timer cleared by Show Widget');
            }
            // Reset permanent hide setting when manually showing
            if (appSettings.widgetHidden) {
              appSettings.widgetHidden = false;
              saveSettings(appSettings);
              log('[Hide] Permanent hide setting reset by Show Widget');
            }
            mainWindow.show();
            mainWindow.focus();
          }
          updateTrayMenu();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Previous Clipboard',
      submenu: clipboardSubmenu,
    },
    { type: 'separator' },
    {
      label: 'Settings',
      click: () => {
        createSettingsWindow();
      },
    },
    {
      label: isDevToolsOpen ? 'Hide Developer Tools' : 'Show Developer Tools',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.webContents.isDevToolsOpened()) {
            mainWindow.webContents.closeDevTools();
          } else {
            mainWindow.webContents.openDevTools({ mode: 'detach' });
          }
          updateTrayMenu();
        }
      },
    },
    ...extraMenuItems,
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        (app as any).isQuitting = true;
        // Destroy tray first to prevent menu callbacks
        if (tray) {
          tray.destroy();
          tray = null;
        }
        // Close all windows explicitly
        BrowserWindow.getAllWindows().forEach(win => {
          win.destroy();
        });
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

const RESTORE_CLIPBOARD_SHORTCUT = 'CommandOrControl+Shift+V';

// Track currently registered hotkey for re-registration
let currentRegisteredHotkey: string | null = null;

function registerGlobalShortcuts() {
  const hotkey = appSettings.hotkey || DEFAULT_HOTKEY;

  // Unregister previous hotkey if different
  if (currentRegisteredHotkey && currentRegisteredHotkey !== hotkey) {
    globalShortcut.unregister(currentRegisteredHotkey);
    log('[Shortcut] Unregistered previous hotkey:', currentRegisteredHotkey);
  }

  const registered = globalShortcut.register(hotkey, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('toggle-recording');
    }
  });

  if (registered) {
    currentRegisteredHotkey = hotkey;
    log('[Shortcut] Registered hotkey:', hotkey);
  } else {
    log('[Shortcut] Failed to register global shortcut:', hotkey);
    currentRegisteredHotkey = null;
  }

  // Register shortcut to restore previous clipboard (only once)
  if (!globalShortcut.isRegistered(RESTORE_CLIPBOARD_SHORTCUT)) {
    const clipboardRestoreRegistered = globalShortcut.register(RESTORE_CLIPBOARD_SHORTCUT, () => {
      const history = getClipboardHistory();
      if (history.length > 0) {
        restoreClipboardEntry(history[0].id);
        log('[Clipboard] Restored previous clipboard via shortcut');
      }
    });

    if (!clipboardRestoreRegistered) {
      log('[Shortcut] Failed to register clipboard restore shortcut:', RESTORE_CLIPBOARD_SHORTCUT);
    }
  }

  setupHoldToRecord();
}

function setupHoldToRecord() {
  if (appSettings.holdToRecordEnabled) {
    const started = startKeyboardHook(appSettings.holdToRecordKey, {
      onKeyDown: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          log('[HoldToRecord] Key down, starting recording');
          // hold-key-down is observed by the renderer to suppress
          // silence-detection auto-stop while the key is physically held.
          mainWindow.webContents.send('hold-key-down');
          mainWindow.webContents.send('start-recording');
        }
      },
      onKeyUp: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          log('[HoldToRecord] Key up, stopping recording');
          mainWindow.webContents.send('hold-key-up');
          mainWindow.webContents.send('stop-recording');
        }
      },
    });
    if (started) {
      log('[HoldToRecord] Started with key:', appSettings.holdToRecordKey);
    } else {
      log('[HoldToRecord] Failed to start keyboard hook');
    }
  } else {
    stopKeyboardHook();
    log('[HoldToRecord] Disabled');
  }
}

async function setupWakeWord() {
  await stopWakeWord();
  if (!appSettings.wakeWordEnabled) {
    log('[WakeWord] Disabled');
    return;
  }
  const ok = await startWakeWord({
    keyword: appSettings.wakeWordKeyword,
    threshold: appSettings.wakeWordThreshold,
    onDetect: ({ keyword, probability }) => {
      log(`[WakeWord] Triggered: ${keyword} (p=${probability.toFixed(3)}) — starting recording`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        // Order matters: renderer must see wake-word-triggered before
        // start-recording so it can flag the upcoming session as hands-free.
        mainWindow.webContents.send('wake-word-triggered');
        mainWindow.webContents.send('start-recording');
      }
    },
    onError: (error) => {
      log('[WakeWord] Error:', error.message);
    },
    onLog: (message) => log(message),
  });
  log(`[WakeWord] setup ok=${ok} keyword=${appSettings.wakeWordKeyword} threshold=${appSettings.wakeWordThreshold}`);
}

function createApplicationMenu() {
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu (macOS only)
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Settings...',
                accelerator: 'CommandOrControl+,',
                click: () => createSettingsWindow(),
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          } as Electron.MenuItemConstructorOptions,
        ]
      : []),
    // Edit menu (for copy/paste support)
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    // View menu with custom DevTools handler
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        {
          label: 'Toggle Developer Tools',
          accelerator: isMac ? 'Alt+Command+I' : 'Ctrl+Shift+I',
          click: () => {
            const focusedWindow = BrowserWindow.getFocusedWindow();
            if (focusedWindow) {
              if (focusedWindow.webContents.isDevToolsOpened()) {
                focusedWindow.webContents.closeDevTools();
              } else {
                focusedWindow.webContents.openDevTools({ mode: 'detach' });
              }
            }
          },
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }]),
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Auto-updater setup
// Update state tracking
let updateDownloaded = false;
let downloadedVersion: string | null = null;
let updateCheckInterval: NodeJS.Timeout | null = null;

// Enable dev testing with: FORCE_UPDATE_CHECK=true bun run dev
const FORCE_UPDATE_CHECK = process.env.FORCE_UPDATE_CHECK === 'true';

function isRendererDevMode(): boolean {
  return process.env.ELECTRON_DEV === 'true' || (!app.isPackaged && !process.env.ELECTRON_FORCE_PROD);
}

function isAutoUpdaterEnabled(): boolean {
  if (IS_LOCAL_DEV_BUILD) {
    return false;
  }

  return app.isPackaged || FORCE_UPDATE_CHECK;
}

function getDisplayVersion(): string {
  if (IS_LOCAL_DEV_BUILD) {
    return 'dev';
  }

  return app.getVersion();
}

function checkForUpdates() {
  log('[AutoUpdater] checkForUpdates called, isPackaged:', app.isPackaged, 'FORCE_UPDATE_CHECK:', FORCE_UPDATE_CHECK, 'LOCAL_DEV_BUILD:', IS_LOCAL_DEV_BUILD);
  if (!isAutoUpdaterEnabled()) {
    log('[AutoUpdater] Skipping update check');
    return;
  }
  log('[AutoUpdater] Starting update check...');
  autoUpdater.checkForUpdates().catch((error) => {
    log('[AutoUpdater] Check failed:', error.message);
  });
}

function installUpdate() {
  if (updateDownloaded) {
    (app as any).isQuitting = true;

    // Destroy tray to prevent menu callbacks
    if (tray) {
      tray.destroy();
      tray = null;
    }

    // Close all windows
    BrowserWindow.getAllWindows().forEach(win => win.destroy());

    // Small delay to ensure cleanup, then install
    setImmediate(() => {
      autoUpdater.quitAndInstall(false, true);
    });
  }
}

function setupAutoUpdater() {
  log('[AutoUpdater] setupAutoUpdater called, isPackaged:', app.isPackaged, 'LOCAL_DEV_BUILD:', IS_LOCAL_DEV_BUILD);
  if (!isAutoUpdaterEnabled()) {
    log('[AutoUpdater] Skipping setup');
    return;
  }

  log('[AutoUpdater] Setting up auto-updater...');

  // Configure GitHub Releases feed for the public repository
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'h0x91b',
    repo: 'Nerd-Dictum',
    private: false,
  });
  log('[AutoUpdater] Feed URL configured for public repo');

  if (FORCE_UPDATE_CHECK && !app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    log('[AutoUpdater] Checking for update...');
  });

  autoUpdater.on('update-available', (info) => {
    log('[AutoUpdater] Update available:', info.version);
  });

  autoUpdater.on('update-not-available', (info) => {
    log('[AutoUpdater] Up to date:', info.version);
  });

  autoUpdater.on('download-progress', (progress) => {
    log(`[AutoUpdater] Downloading: ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    log('[AutoUpdater] Downloaded:', info.version);
    updateDownloaded = true;
    downloadedVersion = info.version;
    updateTrayMenu();

    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `Version ${info.version} has been downloaded.`,
      detail: 'The update will be installed when you restart the app.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    }).then((result) => {
      if (result.response === 0) {
        log('[AutoUpdater] User clicked Restart Now, initiating quit and install...');

        (app as any).isQuitting = true;

        // Destroy tray to prevent menu callbacks
        if (tray) {
          tray.destroy();
          tray = null;
        }

        // Close all windows
        BrowserWindow.getAllWindows().forEach(win => win.destroy());

        // Force quit after 5 seconds if quitAndInstall doesn't work
        const forceQuitTimeout = setTimeout(() => {
          log('[AutoUpdater] Force quitting after timeout...');
          app.exit(0);
        }, 5000);

        // Small delay to ensure cleanup, then install
        setImmediate(() => {
          log('[AutoUpdater] Calling quitAndInstall...');
          autoUpdater.quitAndInstall(false, true);

          // Clear force quit if quitAndInstall worked
          clearTimeout(forceQuitTimeout);
        });
      }
    });
  });

  autoUpdater.on('error', (error) => {
    log('[AutoUpdater] Error:', error.message, error.stack);
  });

  // Initial check for updates
  checkForUpdates();

  // Check for updates every hour
  updateCheckInterval = setInterval(checkForUpdates, 60 * 60 * 1000);
  log('[AutoUpdater] Setup complete');
}

async function requestMicrophonePermission(): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return true; // Only macOS needs explicit permission request
  }

  if (process.platform !== 'darwin') {
    return true;
  }

  const status = systemPreferences.getMediaAccessStatus('microphone');
  log('[Permissions] Microphone access status:', status);

  if (status === 'granted') {
    return true;
  }

  if (status === 'not-determined') {
    // Show dock temporarily — macOS won't show permission dialogs
    // for apps without a dock presence
    if (app.dock && !app.dock.isVisible()) {
      await app.dock.show();
    }

    const granted = await systemPreferences.askForMediaAccess('microphone');
    log('[Permissions] Microphone permission request result:', granted);

    if (app.dock) {
      app.dock.hide();
    }

    if (granted) {
      return true;
    }
  }

  // Either denied, restricted, or askForMediaAccess silently failed (dev mode)
  log('[Permissions] Microphone not granted — opening System Settings');
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
  return false;
}

app.whenReady().then(() => {
  log('[App] Starting Nerd Dictum', getDisplayVersion());

  // Allow microphone access from renderer (getUserMedia).
  // Both handlers are needed: check runs first, then request.
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    log('[Permissions] Check handler:', permission);
    return true;
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    log('[Permissions] Request handler:', permission);
    callback(true);
  });

  // Initialize analytics, track app start, and start hourly heartbeat
  initAnalytics(app.getVersion());
  trackEvent('app_start');
  startHeartbeat();

  // Load settings on app start
  appSettings = loadSettings();

  // Load transcript history for context feature
  loadTranscriptHistory();

  // Load usage statistics
  loadStats();

  // Set dock icon on macOS (especially useful in dev mode)
  if (process.platform === 'darwin' && app.dock) {
    const appIconPath = getAppIconPath();
    const appIcon = nativeImage.createFromPath(appIconPath);
    if (!appIcon.isEmpty()) {
      app.dock.setIcon(appIcon);
    }
    // Hide dock icon initially - it will show when settings/info windows open
    app.dock.hide();
  }

  // Create UI immediately without waiting for background tasks
  createApplicationMenu();
  createWindow();
  createTray();
  registerGlobalShortcuts();
  void setupWakeWord();

  // Warm-load Parakeet at startup when the user has selected a local mode —
  // model load is ~10s on M-series Macs and we'd rather pay it once at boot
  // than during the first transcription.
  if (
    appSettings.transcriptionMode === 'local-then-gemini' ||
    appSettings.transcriptionMode === 'local-only'
  ) {
    parakeetService.ensureStarted().catch((err) => {
      log(`[Parakeet] startup warm-load failed: ${(err as Error).message}`);
    });
  }

  // Hide widget if it was permanently hidden in settings
  if (appSettings.widgetHidden && mainWindow) {
    mainWindow.hide();
    log('[Hide] Widget hidden on startup (permanent hide setting)');
  }

  // Request microphone permission in background (don't block UI)
  requestMicrophonePermission().then((granted) => {
    if (!granted) {
      log('[Permissions] Microphone permission not granted - recording may not work');
    }
  });

  // Check for updates in background after a short delay (don't block UI startup)
  setTimeout(() => {
    setupAutoUpdater();
  }, 2000);
});

app.on('window-all-closed', () => {
  // With tray integration, don't quit when windows are closed
  // The app keeps running in the tray
  if (!tray && process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  (app as any).isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopKeyboardHook();
  void stopWakeWord();
  void parakeetService.stop();
  stopHeartbeat();
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

app.on('activate', () => {
  // Show the window if it's hidden when dock icon is clicked (macOS)
  if (mainWindow) {
    mainWindow.show();
    updateTrayMenu();
  } else if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handlers
ipcMain.handle('copy-to-clipboard', (_event, text: string, autoPaste = false, pressEnterAfter = false) => {
  log('[Clipboard] Copying transcript (' + text.length + ' chars):', text.substring(0, 200));
  const willAutoPaste = autoPaste && appSettings.autoPasteEnabled;
  // Take a snapshot only when we're about to auto-paste; otherwise the
  // transcript is supposed to stay in the clipboard for manual paste.
  const restoreSnapshotEntry = willAutoPaste ? snapshotClipboard() : null;
  // Also push the pre-paste content into the user-visible history so it
  // remains reachable from the tray menu even if the auto-restore races.
  captureCurrentClipboard();
  clipboard.writeText(text);
  // Add our transcribed text to history too
  addTranscriptionToHistory(text);
  // Store transcript for context feature
  addTranscriptToHistory(text);
  // Update tray menu to show new history
  updateTrayMenu();

  if (willAutoPaste) {
    log(`[Clipboard] Auto-paste branch hit — dispatching keystroke (pressEnterAfter=${pressEnterAfter}, hasSnapshot=${restoreSnapshotEntry !== null})`);
    pasteIntoActiveWindow(pressEnterAfter, restoreSnapshotEntry);
  } else {
    log(
      `[Clipboard] Auto-paste SKIPPED: autoPasteArg=${autoPaste}, settingEnabled=${appSettings.autoPasteEnabled}`
    );
  }
  return true;
});

/**
 * Simulate Cmd+V into the currently-focused window so the just-copied
 * transcript lands at the user's cursor without keyboard interaction.
 *
 * Uses `key code 9 using command down` rather than `keystroke "v"` —
 * Electron-based apps (Cursor, VS Code, Slack, …) ignore the
 * character-style `keystroke` form and only react to real keyDown / keyUp
 * pairs that `key code` produces.
 *
 * Requires Accessibility permission. We call
 * isTrustedAccessibilityClient(true) to surface the system prompt the
 * first time, and skip the keystroke (with a clear log line) when the
 * permission isn't granted yet.
 */
// After the keystroke is dispatched, give the target app this long to actually
// process Cmd+V before we put the user's previous clipboard back. Too short
// and the destination reads the restored content; too long and a parallel copy
// from the user gets clobbered. 250 ms is the sweet spot in practice.
const CLIPBOARD_RESTORE_DELAY_MS = 250;

function scheduleClipboardRestore(snapshot: ClipboardEntry | null): void {
  setTimeout(() => {
    try {
      restoreSnapshot(snapshot);
      log(
        `[AutoPaste] clipboard restored (had ${snapshot ? (snapshot.image && !snapshot.image.isEmpty() ? 'image' : 'text') : 'nothing'})`,
      );
    } catch (error) {
      log('[AutoPaste] clipboard restore failed:', (error as Error).message);
    }
  }, CLIPBOARD_RESTORE_DELAY_MS);
}

function pasteIntoActiveWindow(pressEnterAfter = false, restoreSnapshotEntry: ClipboardEntry | null = null): void {
  if (process.platform === 'darwin') {
    const trusted = systemPreferences.isTrustedAccessibilityClient(true);
    log(`[AutoPaste] Accessibility trusted=${trusted}`);
    if (!trusted) {
      log('[AutoPaste] Accessibility permission missing — paste will not work until granted');
      // Without paste we'd still want to leave the transcript on the clipboard
      // so the user can paste manually — skip the restore in that case.
      return;
    }
    // Small delay so the source window can regain focus and the clipboard
    // write is observable to the destination.
    setTimeout(() => {
      const clipNow = clipboard.readText();
      log(
        `[AutoPaste] pre-keystroke: clipboard.length=${clipNow.length} clipboard.head="${clipNow.substring(0, 60).replace(/\n/g, ' ')}"`
      );
      exec(
        `osascript -e 'tell application "System Events" to set frontApp to name of first application process whose frontmost is true' -e 'return frontApp'`,
        (frontErr, frontStdout) => {
          const frontApp = frontStdout?.trim() || '(unknown)';
          log(`[AutoPaste] frontmost app at paste time: "${frontApp}"${frontErr ? ` (err: ${frontErr.message})` : ''}`);
          // Chain V + (optionally) Enter into a single osascript invocation
          // with a short delay between them. If we exec'd two separate
          // osascripts, Enter could land before V finished pasting and the
          // form would submit empty.
          const script = pressEnterAfter
            ? `tell application "System Events" to key code 9 using command down\ndelay 0.25\ntell application "System Events" to key code 36`
            : `tell application "System Events" to key code 9 using command down`;
          log(`[AutoPaste] osascript dispatch (pressEnterAfter=${pressEnterAfter})`);
          exec(
            `osascript -e '${script.replace(/\n/g, "' -e '")}'`,
            (error, _stdout, stderr) => {
              if (error) {
                log('[AutoPaste] Failed:', error.message, '| stderr:', stderr);
              } else {
                log('[AutoPaste] keystroke dispatched OK');
              }
              scheduleClipboardRestore(restoreSnapshotEntry);
            }
          );
        }
      );
    }, 50);
  } else if (process.platform === 'win32') {
    setTimeout(() => {
      const keys = pressEnterAfter ? '^v{ENTER}' : '^v';
      const psScript = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys}')`;
      exec(`powershell -NoProfile -Command "${psScript}"`, (error) => {
        if (error) log('[AutoPaste] Failed:', error.message);
        scheduleClipboardRestore(restoreSnapshotEntry);
      });
    }, 50);
  } else {
    setTimeout(() => {
      const cmd = pressEnterAfter
        ? 'xdotool key --clearmodifiers ctrl+v && sleep 0.25 && xdotool key --clearmodifiers Return'
        : 'xdotool key --clearmodifiers ctrl+v';
      exec(cmd, (error) => {
        if (error) log('[AutoPaste] xdotool not available or failed:', error.message);
        scheduleClipboardRestore(restoreSnapshotEntry);
      });
    }, 50);
  }
}

// Forward arbitrary log lines from the renderer process into the unified
// main-process log (~/Library/Logs/Nerd Dictum/main.log) so timing /
// diagnostic messages from the React side land in the same place as the
// rest of the app's diagnostics.
ipcMain.on('renderer-log', (_event, message: string) => {
  log('[Renderer]', message);
});

ipcMain.handle('list-wake-word-models', () => {
  return listWakeWordModels();
});

ipcMain.handle('parakeet-status', () => {
  return parakeetService.getStatus();
});

ipcMain.handle('parakeet-load-now', async () => {
  try {
    await parakeetService.ensureStarted();
    return { ok: true as const, status: parakeetService.getStatus() };
  } catch (error) {
    const err = error as Error;
    log(`[Parakeet] manual load failed: ${err.message}`);
    return { ok: false as const, error: err.message, status: parakeetService.getStatus() };
  }
});

ipcMain.handle('transcribe-local-stt', async (_event, wavBase64: string) => {
  try {
    // Parakeet wants a real path. Drop the WAV in a temp file, transcribe, unlink.
    const tmpDir = app.getPath('temp');
    const tmpPath = path.join(tmpDir, `nerd-dictum-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
    const buffer = Buffer.from(wavBase64, 'base64');
    fs.writeFileSync(tmpPath, buffer);
    try {
      const result = await parakeetService.transcribe({ wavPath: tmpPath });
      return { ok: true as const, text: result.text, elapsedMs: result.elapsedMs };
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Best effort — leftover temp files self-clean on macOS reboot.
      }
    }
  } catch (error) {
    const err = error as Error;
    log(`[Parakeet] transcribe failed: ${err.message}`);
    return { ok: false as const, error: err.message };
  }
});

ipcMain.handle('open-wake-word-folder', () => {
  const dir = wakeWordCustomDir();
  shell.openPath(dir);
  return dir;
});

ipcMain.handle('list-gemini-models', async () => {
  const apiKey = appSettings.apiKey || process.env.GEMINI_API_KEY || '';
  if (!apiKey) {
    return { ok: false, error: 'API key not set', models: [] };
  }
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`;
    const response = await fetch(url);
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}`, models: [] };
    }
    const data = (await response.json()) as {
      models?: Array<{
        name?: string;
        displayName?: string;
        description?: string;
        supportedGenerationMethods?: string[];
      }>;
    };
    const models = (data.models || [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => {
        const id = (m.name || '').replace(/^models\//, '');
        return {
          id,
          displayName: m.displayName || id,
          description: m.description || '',
        };
      })
      .filter((m) => m.id.startsWith('gemini-'))
      .sort((a, b) => a.id.localeCompare(b.id));
    log(`[Models] fetched ${models.length} Gemini models`);
    return { ok: true, models };
  } catch (error) {
    const err = error as Error;
    log(`[Models] fetch failed: ${err.message}`);
    return { ok: false, error: err.message, models: [] };
  }
});

// API key: prefer saved settings, fallback to env var
ipcMain.handle('get-api-key', () => {
  return appSettings.apiKey || process.env.GEMINI_API_KEY || '';
});

// Model: prefer saved settings, fallback to env var
ipcMain.handle('get-model', () => {
  return appSettings.model || process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
});

// Settings management
ipcMain.handle('get-settings', () => {
  // Sync launchAtStartup with actual system state
  const { openAtLogin } = app.getLoginItemSettings();
  // For apiKey and model: prefer saved settings, fallback to env var
  return {
    apiKey: appSettings.apiKey || process.env.GEMINI_API_KEY || '',
    model: appSettings.model || process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
    languages: appSettings.languages,
    speechDomain: appSettings.speechDomain,
    customDomainHint: appSettings.customDomainHint,
    customKeywords: appSettings.customKeywords,
    microphoneDeviceId: appSettings.microphoneDeviceId,
    silenceDetectionEnabled: appSettings.silenceDetectionEnabled,
    silenceDurationMs: appSettings.silenceDurationMs,
    launchAtStartup: openAtLogin,
    clarificationEnabled: appSettings.clarificationEnabled,
    previousTranscriptContextEnabled: appSettings.previousTranscriptContextEnabled,
    hotkey: appSettings.hotkey || DEFAULT_HOTKEY,
    holdToRecordEnabled: appSettings.holdToRecordEnabled,
    holdToRecordKey: appSettings.holdToRecordKey,
    autoPasteEnabled: appSettings.autoPasteEnabled,
    wakeWordEnabled: appSettings.wakeWordEnabled,
    wakeWordKeyword: appSettings.wakeWordKeyword,
    wakeWordThreshold: appSettings.wakeWordThreshold,
    wakeWordPressEnter: appSettings.wakeWordPressEnter,
    transcriptionMode: appSettings.transcriptionMode,
  };
});

ipcMain.handle('save-settings', (_event, settings: Partial<AppSettings>) => {
  const oldHotkey = appSettings.hotkey;
  const oldWidgetHidden = appSettings.widgetHidden;
  const oldHoldToRecordEnabled = appSettings.holdToRecordEnabled;
  const oldHoldToRecordKey = appSettings.holdToRecordKey;
  const oldWakeWordEnabled = appSettings.wakeWordEnabled;
  const oldWakeWordKeyword = appSettings.wakeWordKeyword;
  const oldWakeWordThreshold = appSettings.wakeWordThreshold;
  appSettings = { ...appSettings, ...settings };
  const result = saveSettings(appSettings);

  // Re-register hotkey if it changed
  if (settings.hotkey !== undefined && settings.hotkey !== oldHotkey) {
    registerGlobalShortcuts();
    updateTrayTooltip();
  }

  // Restart keyboard hook if hold-to-record settings changed
  const holdToRecordChanged =
    (settings.holdToRecordEnabled !== undefined && settings.holdToRecordEnabled !== oldHoldToRecordEnabled) ||
    (settings.holdToRecordKey !== undefined && settings.holdToRecordKey !== oldHoldToRecordKey);
  if (holdToRecordChanged) {
    setupHoldToRecord();
  }

  // Restart wake-word service if its settings changed
  const wakeWordChanged =
    (settings.wakeWordEnabled !== undefined && settings.wakeWordEnabled !== oldWakeWordEnabled) ||
    (settings.wakeWordKeyword !== undefined && settings.wakeWordKeyword !== oldWakeWordKeyword) ||
    (settings.wakeWordThreshold !== undefined && settings.wakeWordThreshold !== oldWakeWordThreshold);
  if (wakeWordChanged) {
    void setupWakeWord();
  }

  // Show/hide widget if widgetHidden setting changed
  if (settings.widgetHidden !== undefined && settings.widgetHidden !== oldWidgetHidden) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (settings.widgetHidden) {
        // Clear any existing timer
        if (hideTimer) {
          clearTimeout(hideTimer);
          hideTimer = null;
        }
        mainWindow.hide();
        log('[Settings] Widget hidden via settings');
      } else {
        mainWindow.show();
        log('[Settings] Widget shown via settings');
      }
      updateTrayMenu();
    }
  }

  return result;
});

// Open settings window
ipcMain.handle('open-settings-window', () => {
  createSettingsWindow();
  return true;
});

// Close settings window
ipcMain.handle('close-settings-window', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
  }
  return true;
});

// Microphone permission handlers
ipcMain.handle('get-microphone-permission-status', () => {
  if (process.platform !== 'darwin') {
    return 'granted'; // Non-macOS platforms don't need explicit permission
  }
  return systemPreferences.getMediaAccessStatus('microphone');
});

ipcMain.handle('request-microphone-permission', async () => {
  return requestMicrophonePermission();
});

// Open external URL in default browser
ipcMain.handle('open-external-url', (_event, url: string) => {
  // Only allow https URLs for security
  if (url.startsWith('https://')) {
    shell.openExternal(url);
    return true;
  }
  return false;
});

// Open info window
ipcMain.handle('open-info-window', () => {
  createInfoWindow();
  return true;
});

// Open hide window
ipcMain.handle('open-hide-window', () => {
  createHideWindow();
  return true;
});

// Close hide window
ipcMain.handle('close-hide-window', () => {
  if (hideWindow && !hideWindow.isDestroyed()) {
    hideWindow.close();
  }
  return true;
});

// Get app version
ipcMain.handle('get-app-version', () => {
  if (!app.isPackaged || IS_LOCAL_DEV_BUILD) {
    return 'dev';
  }
  return app.getVersion();
});

// Get recent transcripts for context (last 3)
ipcMain.handle('get-recent-transcripts', () => {
  return getRecentTranscripts();
});

// Hide widget for a specified duration (-1 means forever/permanent)
ipcMain.handle('hide-for-duration', (_event, durationMs: number) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  // Clear any existing timer
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  // Close hide window if open
  if (hideWindow && !hideWindow.isDestroyed()) {
    hideWindow.close();
  }

  // Hide the main window
  mainWindow.hide();
  updateTrayMenu();

  // If durationMs is -1, hide forever (save to settings)
  if (durationMs === -1) {
    log('[Hide] Widget hidden permanently');
    appSettings.widgetHidden = true;
    saveSettings(appSettings);
  } else {
    log('[Hide] Widget hidden for', durationMs, 'ms');
    // Set timer to show window again
    hideTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        updateTrayMenu();
        log('[Hide] Widget shown after timer');
      }
      hideTimer = null;
    }, durationMs);
  }

  return true;
});

// Analytics event tracking from renderer
ipcMain.handle('track-event', (_event, name: string, params: Record<string, string | number> = {}) => {
  trackEvent(name, params);
});

// Media control for pausing/resuming during recording
ipcMain.handle('pause-media', () => {
  pauseMediaPlayback();
});

ipcMain.handle('resume-media', () => {
  resumeMediaPlayback();
});

// Stats window handlers
ipcMain.handle('open-stats-window', () => {
  createStatsWindow();
  return true;
});

ipcMain.handle('close-stats-window', () => {
  if (statsWindow && !statsWindow.isDestroyed()) {
    statsWindow.close();
  }
  return true;
});

ipcMain.handle('get-stats', () => {
  return getStatsWithDerived();
});

ipcMain.handle('reset-stats', () => {
  resetStats();
  return true;
});

ipcMain.handle('record-transcription-stats', (_event, transcript: string, recordingDurationMs: number) => {
  recordTranscription(transcript, recordingDurationMs);
  return true;
});

// Error detail window handlers
ipcMain.handle('open-error-detail-window', (_event, detail: { message: string; statusCode?: number; responseBody?: string }) => {
  pendingErrorDetail = detail;
  createErrorDetailWindow();
  return true;
});

ipcMain.handle('get-error-detail', () => {
  return pendingErrorDetail || { message: 'Unknown error' };
});

// Read a file and return its contents as base64
ipcMain.handle('read-file-as-base64', (_event, filePath: string) => {
  try {
    const data = fs.readFileSync(filePath);
    return data.toString('base64');
  } catch (error) {
    log('[File] Failed to read file:', filePath, error);
    throw error;
  }
});
