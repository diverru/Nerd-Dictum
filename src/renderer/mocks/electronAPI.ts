/**
 * Mock implementation of electronAPI for browser development.
 * This allows the UI to be developed and tested without Electron.
 */
import type { AppSettings, MicrophonePermissionStatus, StatsWithDerived, ErrorDetail } from '../types/electron';

const defaultSettings: AppSettings = {
  apiKey: '',
  model: 'gemini-2.0-flash',
  languages: ['en', 'he', 'ru'],
  speechDomain: 'general',
  customDomainHint: '',
  customKeywords: '',
  microphoneDeviceId: 'default',
  silenceDetectionEnabled: true,
  silenceDurationMs: 1500,
  launchAtStartup: false,
  clarificationEnabled: false,
  previousTranscriptContextEnabled: false,
  soundEnabled: true,
  hotkey: 'CommandOrControl+Shift+R',
  widgetHidden: false,
  holdToRecordEnabled: true,
  holdToRecordKey: 'RightMeta',
  autoPasteEnabled: true,
  wakeWordEnabled: false,
  wakeWordKeyword: 'hey_jarvis',
  wakeWordThreshold: 0.5,
  wakeWordPressEnter: true,
};

const defaultStats: StatsWithDerived = {
  totalTranscriptions: 0,
  totalWords: 0,
  totalCharacters: 0,
  totalRecordingTimeMs: 0,
  firstUseDate: '',
  lastUseDate: '',
  dailyStats: [],
  averageWordsPerTranscription: 0,
  mostActiveDay: 'N/A',
  timeSavedSeconds: 0,
};

let mockSettings = { ...defaultSettings };
let mockStats = { ...defaultStats };
let mockRecentTranscripts: string[] = ['This is a mock transcript for browser development.'];

const toggleRecordingCallbacks = new Set<() => void>();

export function setupElectronAPIMock() {
  if (window.electronAPI) {
    // Already has real electronAPI, don't override
    return;
  }

  console.log('[Mock] Setting up electronAPI mock for browser development');

  window.electronAPI = {
    copyToClipboard: async (text: string, _autoPaste?: boolean): Promise<boolean> => {
      try {
        await navigator.clipboard.writeText(text);
        console.log('[Mock] Copied to clipboard:', text.substring(0, 50) + '...');
        return true;
      } catch (err) {
        console.error('[Mock] Failed to copy to clipboard:', err);
        return false;
      }
    },

    getApiKey: async (): Promise<string> => {
      return mockSettings.apiKey;
    },

    getModel: async (): Promise<string> => {
      return mockSettings.model;
    },

    onToggleRecording: (callback: () => void): (() => void) => {
      toggleRecordingCallbacks.add(callback);
      console.log('[Mock] Registered toggle recording callback. Press Cmd/Ctrl+Shift+R to toggle.');
      return () => {
        toggleRecordingCallbacks.delete(callback);
      };
    },

    onStartRecording: (_callback: () => void): (() => void) => {
      // No-op for browser mock - hold-to-record is Electron-only
      return () => {};
    },

    onStopRecording: (_callback: () => void): (() => void) => {
      // No-op for browser mock - hold-to-record is Electron-only
      return () => {};
    },

    getSettings: async (): Promise<AppSettings> => {
      return { ...mockSettings };
    },

    saveSettings: async (settings: Partial<AppSettings>): Promise<boolean> => {
      mockSettings = { ...mockSettings, ...settings };
      console.log('[Mock] Settings saved:', settings);
      return true;
    },

    openSettingsWindow: async (): Promise<boolean> => {
      console.log('[Mock] Would open settings window');
      // In browser, we could open a new tab or modal
      window.open('/settings.html', '_blank', 'width=600,height=700');
      return true;
    },

    closeSettingsWindow: async (): Promise<boolean> => {
      console.log('[Mock] Would close settings window');
      return true;
    },

    openInfoWindow: async (): Promise<boolean> => {
      console.log('[Mock] Would open info window');
      window.open('/info.html', '_blank', 'width=400,height=500');
      return true;
    },

    getMicrophonePermissionStatus: async (): Promise<MicrophonePermissionStatus> => {
      try {
        const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        if (result.state === 'granted') return 'granted';
        if (result.state === 'denied') return 'denied';
        return 'not-determined';
      } catch {
        return 'unknown';
      }
    },

    requestMicrophonePermission: async (): Promise<boolean> => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop());
        return true;
      } catch {
        return false;
      }
    },

    openExternalUrl: async (url: string): Promise<boolean> => {
      window.open(url, '_blank');
      return true;
    },

    getAppVersion: async (): Promise<string> => {
      return '0.0.0-browser-dev';
    },

    getRecentTranscripts: async (): Promise<string[]> => {
      return mockRecentTranscripts;
    },

    openHideWindow: async (): Promise<boolean> => {
      console.log('[Mock] Would open hide window');
      return true;
    },

    closeHideWindow: async (): Promise<boolean> => {
      console.log('[Mock] Would close hide window');
      return true;
    },

    hideForDuration: async (durationMs: number): Promise<boolean> => {
      console.log('[Mock] Would hide for duration:', durationMs, 'ms');
      return true;
    },

    trackEvent: async (name: string, params?: Record<string, string | number>): Promise<void> => {
      console.log('[Mock] Track event:', name, params);
    },

    pauseMedia: async (): Promise<void> => {
      console.log('[Mock] Would pause media playback');
    },

    resumeMedia: async (): Promise<void> => {
      console.log('[Mock] Would resume media playback');
    },

    openStatsWindow: async (): Promise<boolean> => {
      console.log('[Mock] Would open stats window');
      window.open('/stats.html', '_blank', 'width=420,height=720');
      return true;
    },

    closeStatsWindow: async (): Promise<boolean> => {
      console.log('[Mock] Would close stats window');
      return true;
    },

    getStats: async (): Promise<StatsWithDerived> => {
      return { ...mockStats };
    },

    resetStats: async (): Promise<boolean> => {
      mockStats = { ...defaultStats };
      console.log('[Mock] Stats reset');
      return true;
    },

    recordTranscriptionStats: async (transcript: string, recordingDurationMs: number): Promise<boolean> => {
      const words = transcript.trim().split(/\s+/).filter(w => w.length > 0).length;
      mockStats.totalTranscriptions += 1;
      mockStats.totalWords += words;
      mockStats.totalCharacters += transcript.length;
      mockStats.totalRecordingTimeMs += recordingDurationMs;
      console.log('[Mock] Recorded stats:', { words, chars: transcript.length, durationMs: recordingDurationMs });
      return true;
    },

    openErrorDetailWindow: async (detail: ErrorDetail): Promise<boolean> => {
      console.log('[Mock] Would open error detail window:', detail);
      return true;
    },

    getErrorDetail: async (): Promise<ErrorDetail> => {
      return { message: 'Mock error' };
    },

    getPathForFile: (file: File): string => {
      console.log('[Mock] getPathForFile:', file.name);
      return `/mock/path/${file.name}`;
    },

    readFileAsBase64: async (filePath: string): Promise<string> => {
      console.log('[Mock] Would read file as base64:', filePath);
      return '';
    },

    listGeminiModels: async () => {
      return { ok: true as const, models: [] };
    },
  };

  // Set up keyboard shortcut for toggle recording (Cmd/Ctrl+Shift+R)
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      console.log('[Mock] Toggle recording triggered via keyboard');
      toggleRecordingCallbacks.forEach(cb => cb());
    }
  });
}

// For testing: expose functions to simulate events
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__mockElectronAPI = {
    triggerToggleRecording: () => {
      toggleRecordingCallbacks.forEach(cb => cb());
    },
    setMockTranscripts: (transcripts: string[]) => {
      mockRecentTranscripts = transcripts;
    },
    setMockSettings: (settings: Partial<AppSettings>) => {
      mockSettings = { ...mockSettings, ...settings };
    },
  };
}
