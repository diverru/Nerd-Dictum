import type { AppSettings, HoldToRecordKey, StatsWithDerived, DailyStats } from '../../shared/types';
export type { AppSettings, HoldToRecordKey, StatsWithDerived, DailyStats };

export type MicrophonePermissionStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

export interface ErrorDetail {
  message: string;
  statusCode?: number;
  responseBody?: string;
  /** Absolute path to the saved recording that failed, when it could be saved */
  audioFilePath?: string;
  audioFileName?: string;
  audioSizeBytes?: number;
}

export interface SavedRecording {
  filePath: string;
  fileName: string;
  sizeBytes: number;
}

export interface ElectronAPI {
  copyToClipboard: (text: string, autoPaste?: boolean) => Promise<boolean>;
  log?: (message: string) => void;
  listGeminiModels?: () => Promise<
    | { ok: true; models: Array<{ id: string; displayName: string; description: string }> }
    | { ok: false; error: string; models: [] }
  >;
  listProviderModels?: (
    provider: 'google' | 'openai',
    apiKey: string,
  ) => Promise<
    | { ok: true; models: Array<{ id: string; displayName: string }> }
    | { ok: false; error: string; models: [] }
  >;
  parakeetStatus?: () => Promise<{ state: 'idle' | 'starting' | 'ready' | 'failed'; error?: string; loadDurationMs?: number }>;
  parakeetLoadNow?: () => Promise<
    | { ok: true; status: { state: string; error?: string; loadDurationMs?: number } }
    | { ok: false; error: string; status: { state: string; error?: string; loadDurationMs?: number } }
  >;
  transcribeLocalStt?: (wavBase64: string) => Promise<
    | { ok: true; text: string; elapsedMs: number }
    | { ok: false; error: string }
  >;
  onParakeetStatusChange?: (callback: (status: { state: string; error?: string; loadDurationMs?: number }) => void) => () => void;
  onWidgetStyleChange?: (callback: (style: 'full' | 'minimal') => void) => () => void;
  showWidgetMenu?: () => void;
  widgetDragStart?: () => void;
  widgetDragMove?: (dx: number, dy: number) => void;
  getApiKey: () => Promise<string>;
  getModel: () => Promise<string>;
  onToggleRecording: (callback: () => void) => () => void;
  onStartRecording: (callback: () => void) => () => void;
  onStopRecording: (callback: () => void) => () => void;
  onCancelRecording?: (callback: () => void) => () => void;
  onHoldKeyDown?: (callback: () => void) => () => void;
  onHoldKeyUp?: (callback: () => void) => () => void;
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<boolean>;
  openSettingsWindow: () => Promise<boolean>;
  closeSettingsWindow: () => Promise<boolean>;
  openInfoWindow: () => Promise<boolean>;
  openHideWindow: () => Promise<boolean>;
  closeHideWindow: () => Promise<boolean>;
  getMicrophonePermissionStatus: () => Promise<MicrophonePermissionStatus>;
  requestMicrophonePermission: () => Promise<boolean>;
  requestAccessibilityPermission?: () => Promise<boolean>;
  openExternalUrl: (url: string) => Promise<boolean>;
  getAppVersion: () => Promise<string>;
  getRecentTranscripts: () => Promise<string[]>;
  getTranscriptHistory: () => Promise<string[]>;
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
  // Failed recordings
  saveFailedRecording: (audioBase64: string, mimeType?: string) => Promise<SavedRecording | null>;
  showItemInFolder: (filePath: string) => Promise<boolean>;
  retryFailedRecording: (filePath: string) => Promise<boolean>;
  onRetryTranscription: (callback: (filePath: string) => void) => () => void;
  // File operations
  getPathForFile: (file: File) => string;
  readFileAsBase64: (filePath: string) => Promise<string>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
