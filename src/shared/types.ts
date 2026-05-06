export type HoldToRecordKey =
  | 'LeftControl'
  | 'RightControl'
  | 'LeftAlt'
  | 'RightAlt'
  | 'LeftMeta'
  | 'RightMeta'
  | 'LeftShift'
  | 'RightShift';

export interface AppSettings {
  apiKey: string;
  model: string;
  languages: string[];
  speechDomain: string;
  customDomainHint: string;
  customKeywords: string;
  microphoneDeviceId: string;
  silenceDetectionEnabled: boolean;
  silenceDurationMs: number;
  launchAtStartup: boolean;
  clarificationEnabled: boolean;
  previousTranscriptContextEnabled: boolean;
  soundEnabled: boolean;
  hotkey: string;
  widgetHidden: boolean;
  holdToRecordEnabled: boolean;
  holdToRecordKey: HoldToRecordKey;
  autoPasteEnabled: boolean;
}

export interface DailyStats {
  date: string; // ISO format: "2025-01-15"
  transcriptions: number;
  words: number;
  characters: number;
  recordingTimeMs: number;
}

export interface StatsData {
  totalTranscriptions: number;
  totalWords: number;
  totalCharacters: number;
  totalRecordingTimeMs: number;
  firstUseDate: string; // ISO date
  lastUseDate: string; // ISO date
  dailyStats: DailyStats[];
}

export interface DerivedStats {
  averageWordsPerTranscription: number;
  mostActiveDay: string;
  timeSavedSeconds: number;
}

export type StatsWithDerived = StatsData & DerivedStats;
