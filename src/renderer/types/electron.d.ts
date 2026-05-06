import type { AppSettings, HoldToRecordKey, StatsWithDerived, DailyStats } from '../../shared/types';
export type { AppSettings, HoldToRecordKey, StatsWithDerived, DailyStats };

export type MicrophonePermissionStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

export interface ErrorDetail {
  message: string;
  statusCode?: number;
  responseBody?: string;
}

export interface ElectronAPI {
  copyToClipboard: (text: string) => Promise<boolean>;
  log?: (message: string) => void;
  getApiKey: () => Promise<string>;
  getModel: () => Promise<string>;
  onToggleRecording: (callback: () => void) => () => void;
  onStartRecording: (callback: () => void) => () => void;
  onStopRecording: (callback: () => void) => () => void;
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<boolean>;
  openSettingsWindow: () => Promise<boolean>;
  closeSettingsWindow: () => Promise<boolean>;
  openInfoWindow: () => Promise<boolean>;
  openHideWindow: () => Promise<boolean>;
  closeHideWindow: () => Promise<boolean>;
  getMicrophonePermissionStatus: () => Promise<MicrophonePermissionStatus>;
  requestMicrophonePermission: () => Promise<boolean>;
  openExternalUrl: (url: string) => Promise<boolean>;
  getAppVersion: () => Promise<string>;
  getRecentTranscripts: () => Promise<string[]>;
  hideForDuration: (durationMs: number) => Promise<boolean>;
  trackEvent: (name: string, params?: Record<string, string | number>) => Promise<void>;
  pauseMedia: () => Promise<void>;
  resumeMedia: () => Promise<void>;
  // Stats
  openStatsWindow: () => Promise<boolean>;
  closeStatsWindow: () => Promise<boolean>;
  getStats: () => Promise<StatsWithDerived>;
  resetStats: () => Promise<boolean>;
  recordTranscriptionStats: (transcript: string, recordingDurationMs: number) => Promise<boolean>;
  // Error detail
  openErrorDetailWindow: (detail: ErrorDetail) => Promise<boolean>;
  getErrorDetail: () => Promise<ErrorDetail>;
  // File operations
  getPathForFile: (file: File) => string;
  readFileAsBase64: (filePath: string) => Promise<string>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
