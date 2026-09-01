/**
 * The cool-down block: a full-screen pause the user cannot dismiss.
 *
 * Deliberately has no escape hatch — that was the speaker's explicit call, and
 * the point of the feature. In this soft form the operating system still
 * offers one (force quit, Cmd-Q, the lock screen), which is why the decision
 * costs nothing today; it becomes a real one only if the block is ever made
 * to disable process switching natively.
 *
 * What is NOT an escape hatch, and is load-bearing: the timer that ends the
 * block lives here, in the main process, independent of the windows it opened.
 * If a renderer hangs or a display disappears, the block still ends on time.
 * A timer that can silently fail to fire is a trap, not a feature.
 */

import { BrowserWindow, screen, app } from 'electron';
import path from 'path';

export interface CooldownRequest {
  seconds: number;
  /** How many tense recordings in a row triggered this. */
  streak: number;
  /** The most telling thing they said, if we have it. */
  quote?: string;
}

type Logger = (...args: unknown[]) => void;

let windows: BrowserWindow[] = [];
let endTimer: NodeJS.Timeout | null = null;
let active = false;

export function isCooldownActive(): boolean {
  return active;
}

/**
 * Open the block on every display and close it after `seconds`.
 *
 * Calling while a block is already running does nothing: a second trigger
 * must not extend a punishment already being served.
 */
export function startCooldown(
  request: CooldownRequest,
  opts: { isDev: boolean; devPort: number; log: Logger }
): boolean {
  if (active) return false;
  active = true;

  const displays = screen.getAllDisplays();
  opts.log(
    `[Cooldown] blocking ${displays.length} display(s) for ${request.seconds}s ` +
      `after ${request.streak} tense recordings`
  );

  windows = displays.map((display) => {
    const win = new BrowserWindow({
      ...display.bounds,
      frame: false,
      transparent: false,
      backgroundColor: '#1a0d0d',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Shown only once it has painted, so the block never flashes an empty
      // white rectangle in the user's face.
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Above everything the ordinary window levels can reach, including other
    // apps' full-screen windows.
    win.setAlwaysOnTop(true, 'screen-saver');
    if (process.platform === 'darwin') {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }

    // Cmd-Tab still switches apps; this pulls focus straight back, so the
    // block stays in front of whatever was switched to.
    win.on('blur', () => {
      if (active && !win.isDestroyed()) win.focus();
    });

    if (opts.isDev) {
      win.loadURL(`http://localhost:${opts.devPort}/cooldown.html`);
    } else {
      win.loadFile(path.join(__dirname, '../renderer/cooldown.html'));
    }

    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
      win.webContents.send('cooldown-info', request);
    });

    return win;
  });

  endTimer = setTimeout(() => endCooldown(opts.log), request.seconds * 1000);
  return true;
}

/** Close the block. Safe to call when nothing is open. */
export function endCooldown(log: Logger): void {
  if (endTimer) {
    clearTimeout(endTimer);
    endTimer = null;
  }
  // Cleared before destroying, so the blur handler above does not fight the
  // teardown by refocusing a window on its way out.
  active = false;

  for (const win of windows) {
    if (!win.isDestroyed()) {
      // These windows are closable: false, so close() would be ignored.
      win.destroy();
    }
  }
  if (windows.length > 0) log('[Cooldown] block over');
  windows = [];
}

/** Quitting must not leave an undismissable window behind. */
export function registerCooldownShutdown(log: Logger): void {
  app.on('before-quit', () => endCooldown(log));
}
