import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppSettings } from '../shared/types';

contextBridge.exposeInMainWorld('electronAPI', {
  copyToClipboard: (text: string) => ipcRenderer.invoke('copy-to-clipboard', text),
  log: (message: string) => ipcRenderer.send('renderer-log', message),
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
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings: Partial<AppSettings>) => ipcRenderer.invoke('save-settings', settings),
  openSettingsWindow: () => ipcRenderer.invoke('open-settings-window'),
  closeSettingsWindow: () => ipcRenderer.invoke('close-settings-window'),
  openInfoWindow: () => ipcRenderer.invoke('open-info-window'),
  openHideWindow: () => ipcRenderer.invoke('open-hide-window'),
  closeHideWindow: () => ipcRenderer.invoke('close-hide-window'),
  getMicrophonePermissionStatus: () => ipcRenderer.invoke('get-microphone-permission-status'),
  requestMicrophonePermission: () => ipcRenderer.invoke('request-microphone-permission'),
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
