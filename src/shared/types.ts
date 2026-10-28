export type HoldToRecordKey =
  | 'LeftControl'
  | 'RightControl'
  | 'LeftAlt'
  | 'RightAlt'
  | 'LeftMeta'
  | 'RightMeta'
  | 'LeftShift'
  | 'RightShift';

// Cloud speech-to-text providers: `google` (Gemini) and `openai`.
export type CloudProvider = 'google' | 'openai';

// Per-provider key + model. Stored separately so switching providers does not
// erase the user's other credentials.
export interface ProviderConfig {
  apiKey: string;
  model: string;
}

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
  // 'full' = the 80x100 widget with buttons. 'minimal' = a 22x108 vertical mixer-style strip.
  widgetStyle: 'full' | 'minimal';
  holdToRecordEnabled: boolean;
  holdToRecordKey: HoldToRecordKey;
  autoPasteEnabled: boolean;
  // 'cloud' = audio → the provider chosen in `cloudProvider`, transcript pasted as is.
  // 'local' = Parakeet TDT v3 (Swift+CoreML), zero network.
  transcriptionMode: 'cloud' | 'local';
  // The legacy `apiKey` / `model` fields above are the Google Gemini config.
  // OpenAI credentials live in `providerConfigs.openai`.
  cloudProvider: CloudProvider;
  providerConfigs: { openai?: ProviderConfig };
  // What to do with system audio while recording.
  // 'duck' — lower system volume to RECORDING_VOLUME (default, smooth).
  // 'mute' — fully mute system output. Lands harder/instant, no fade.
  // 'none' — leave audio alone. The user manages it manually.
  mediaPauseMode: 'duck' | 'mute' | 'none';
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
