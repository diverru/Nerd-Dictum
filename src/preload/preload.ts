import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppSettings } from '../shared/types';

contextBridge.exposeInMainWorld('electronAPI', {
  copyToClipboard: (text: string, autoPaste = false, pressEnterAfter = false) =>
    ipcRenderer.invoke('copy-to-clipboard', text, autoPaste, pressEnterAfter),
  log: (message: string) => ipcRenderer.send('renderer-log', message),
  listWakeWordModels: () => ipcRenderer.invoke('list-wake-word-models'),
  openWakeWordFolder: () => ipcRenderer.invoke('open-wake-word-folder'),
  listGeminiModels: () => ipcRenderer.invoke('list-gemini-models'),
  listProviderModels: (provider: string, apiKey: string) =>
    ipcRenderer.invoke('list-provider-models', provider, apiKey),
  polishText: (
    provider: string,
    apiKey: string,
    model: string,
    rawTranscript: string,
    options?: { languages?: string[]; customKeywords?: string; previousTranscripts?: string[] },
  ) => ipcRenderer.invoke('polish-text', provider, apiKey, model, rawTranscript, options),
  parakeetStatus: () => ipcRenderer.invoke('parakeet-status'),
  parakeetLoadNow: () => ipcRenderer.invoke('parakeet-load-now'),
  transcribeLocalStt: (wavBase64: string) => ipcRenderer.invoke('transcribe-local-stt', wavBase64),
  onParakeetStatusChange: (callback: (status: { state: string; error?: string; loadDurationMs?: number }) => void) => {
    const listener = (_event: unknown, status: { state: string; error?: string; loadDurationMs?: number }) => callback(status);
    ipcRenderer.on('parakeet-status-change', listener);
    return () => {
      ipcRenderer.removeListener('parakeet-status-change', listener);
    };
  },
  getApiKey: () => ipcRenderer.invoke('get-api-key'),
  getModel: () => ipcRenderer.invoke('get-model'),
  onToggleRecording: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('toggle-recording', listener);
    return () => {
      ipcRenderer.removeListener('toggle-recording', listener);
    };
  },
  onStartRecording: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('start-recording', listener);
    return () => {
      ipcRenderer.removeListener('start-recording', listener);
    };
  },
  onStopRecording: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('stop-recording', listener);
    return () => {
      ipcRenderer.removeListener('stop-recording', listener);
    };
  },
  onCancelRecording: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('cancel-recording', listener);
    return () => {
      ipcRenderer.removeListener('cancel-recording', listener);
    };
  },
  onHoldKeyDown: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('hold-key-down', listener);
    return () => {
      ipcRenderer.removeListener('hold-key-down', listener);
    };
  },
  onHoldKeyUp: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('hold-key-up', listener);
    return () => {
      ipcRenderer.removeListener('hold-key-up', listener);
    };
  },
  onWakeWordTriggered: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('wake-word-triggered', listener);
    return () => {
      ipcRenderer.removeListener('wake-word-triggered', listener);
    };
  },
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings: Partial<AppSettings>) => ipcRenderer.invoke('save-settings', settings),
  openSettingsWindow: () => ipcRenderer.invoke('open-settings-window'),
  closeSettingsWindow: () => ipcRenderer.invoke('close-settings-window'),
  openInfoWindow: () => ipcRenderer.invoke('open-info-window'),
  openHideWindow: () => ipcRenderer.invoke('open-hide-window'),
  closeHideWindow: () => ipcRenderer.invoke('close-hide-window'),
  getMicrophonePermissionStatus: () => ipcRenderer.invoke('get-microphone-permission-status'),
  requestMicrophonePermission: () => ipcRenderer.invoke('request-microphone-permission'),
  requestAccessibilityPermission: () => ipcRenderer.invoke('request-accessibility-permission'),
  openExternalUrl: (url: string) => ipcRenderer.invoke('open-external-url', url),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getRecentTranscripts: () => ipcRenderer.invoke('get-recent-transcripts'),
  hideForDuration: (durationMs: number) => ipcRenderer.invoke('hide-for-duration', durationMs),
  trackEvent: (name: string, params?: Record<string, string | number>) =>
    ipcRenderer.invoke('track-event', name, params ?? {}),
  pauseMedia: () => ipcRenderer.invoke('pause-media'),
  resumeMedia: () => ipcRenderer.invoke('resume-media'),
  // Stats
  openStatsWindow: () => ipcRenderer.invoke('open-stats-window'),
  closeStatsWindow: () => ipcRenderer.invoke('close-stats-window'),
  getStats: () => ipcRenderer.invoke('get-stats'),
  resetStats: () => ipcRenderer.invoke('reset-stats'),
  recordTranscriptionStats: (transcript: string, recordingDurationMs: number) =>
    ipcRenderer.invoke('record-transcription-stats', transcript, recordingDurationMs),
  // Error detail
  openErrorDetailWindow: (detail: { message: string; statusCode?: number; responseBody?: string }) =>
    ipcRenderer.invoke('open-error-detail-window', detail),
  getErrorDetail: () => ipcRenderer.invoke('get-error-detail'),
  // File operations
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  readFileAsBase64: (filePath: string) => ipcRenderer.invoke('read-file-as-base64', filePath),
});
