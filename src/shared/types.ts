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
  wakeWordEnabled: boolean;
  // Either a built-in name ("hey_jarvis", "alexa", "hey_mycroft") OR a
  // filename (without extension) of a custom .onnx model that lives in
  // <userData>/wake-words/.
  wakeWordKeyword: string;
  wakeWordThreshold: number;
  // After auto-paste, also press Enter so chat / form / prompt-style targets
  // submit hands-free. Only effective when the recording was started by the
  // wake-word detector (manual hold-key recordings always paste without Enter).
  wakeWordPressEnter: boolean;
  // 'gemini' = audio → Gemini directly (default).
  // 'local-then-gemini' = Parakeet TDT v3 (Swift+CoreML) for raw transcript,
  //   then Gemini polishes with no audio attached. Avoids audio upload latency.
  // 'local-only' = Parakeet alone, no LLM polish (zero network).
  transcriptionMode: 'gemini' | 'local-then-gemini' | 'local-only';
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
