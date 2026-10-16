import { DEFAULT_OPENAI_MODEL } from '../lib/openai-stt';

// Settings written before the two-mode split (`cloud` / `local`). The stored
// API keys are kept; only the mode fields change, and keys of removed
// features are dropped so they are not saved back forever.
export function migrateSettings(parsed: Record<string, any>): Record<string, any> {
  const { polishProvider, nervousness, wakeWordEnabled, wakeWordKeyword, wakeWordThreshold, wakeWordPressEnter, ...rest } = parsed;
  switch (rest.transcriptionMode) {
    case 'gemini':
      return { ...rest, transcriptionMode: 'cloud', cloudProvider: 'google' };
    case 'local-then-gemini':
      // The model stored for OpenAI was a polish model; polish is gone.
      return {
        ...rest,
        transcriptionMode: 'cloud',
        cloudProvider: 'openai',
        providerConfigs: {
          ...rest.providerConfigs,
          openai: { apiKey: '', ...rest.providerConfigs?.openai, model: DEFAULT_OPENAI_MODEL },
        },
      };
    case 'local-only':
      return { ...rest, transcriptionMode: 'local' };
    default:
      return rest;
  }
}
