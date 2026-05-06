export type HoldToRecordKey =
  | 'LeftControl'
  | 'RightControl'
  | 'LeftAlt'
  | 'RightAlt'
  | 'LeftMeta'
  | 'RightMeta'
  | 'LeftShift'
  | 'RightShift';

// Cloud LLM providers used for the Polish step (text → text). The STT step
// is locked to Google Gemini in `gemini` transcriptionMode and to local
// Parakeet in the `local-*` modes — only Polish is provider-pluggable.
export type LLMProviderId = 'google' | 'openai' | 'anthropic' | 'groq' | 'deepseek';

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
  // Which provider does Polish in `local-then-gemini` mode. The legacy
  // `apiKey` / `model` fields above remain the canonical Google Gemini
  // config (used both for direct STT and when polishProvider === 'google').
  // For the other providers, credentials live in `providerConfigs`.
  polishProvider: LLMProviderId;
  // Per-provider { apiKey, model } for non-Google providers. Switching the
  // active polish provider doesn't erase the other entries.
  providerConfigs: Partial<Record<Exclude<LLMProviderId, 'google'>, ProviderConfig>>;
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
