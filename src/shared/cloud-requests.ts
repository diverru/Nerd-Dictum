import type { TranscribeRequestOptions } from '../lib/gemini';
import type { OpenAIRequestOptions } from '../lib/openai-stt';
import type { PolishOptions } from '../lib/polish';

// AbortSignal and callbacks cannot cross Electron's structured-clone boundary.
export type CloudRequest =
  | { kind: 'google'; audioBase64: string; apiKey: string; model?: string; options?: Omit<TranscribeRequestOptions, 'signal'> }
  | { kind: 'openai'; audioBase64: string; apiKey: string; model?: string; options?: Omit<OpenAIRequestOptions, 'signal'> }
  | { kind: 'polish'; text: string; options: Omit<PolishOptions, 'signal' | 'onLog'> };

export type CloudResult =
  | { ok: true; text: string }
  | { ok: false; error: { name: string; message: string; statusCode?: number; responseBody?: string } };
