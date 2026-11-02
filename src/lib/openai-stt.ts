/**
 * OpenAI API client for speech-to-text transcription
 */

import {
  ApiResponseError,
  TranscriptionCancelledError,
  parseCustomKeywords,
  getTimeoutForAttempt,
  waitForRetryDelayMs,
  MAX_ATTEMPTS,
  RETRY_DELAY_MS,
  type TranscribeRequestOptions,
} from './gemini';

export const DEFAULT_OPENAI_MODEL = 'gpt-transcribe';
const TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';
// OpenAI rejects uploads over 25 MB. Base64 inflates by 4/3.
export const OPENAI_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const DEFAULT_TRANSCRIPTION_PROMPT =
  'Диктовка разработчика. Он пишет на Python и C++, работает с React и JavaScript во всех его формах. Английские технические термины пишутся латиницей.';
// Whole prompt: the user's text plus the vocabulary list.
const MAX_PROMPT_CHARS = 1000;
const MAX_HINT_HISTORY_TERMS = 45;
const MAX_HINT_CUSTOM_TERMS = 20;
const LATIN_TOKEN = /[A-Za-z][A-Za-z0-9.+#_-]{1,}/g;
// Common English words that show up in transcripts without being vocabulary.
const STOP_WORDS = new Set([
  'the', 'is', 'get', 'last', 'none', 'full', 'available', 'and', 'for', 'with', 'this', 'that',
  'from', 'not', 'are', 'was', 'has', 'have', 'but', 'you', 'your', 'can', 'will', 'all', 'new',
  'one', 'use', 'set', 'see', 'out', 'now', 'just', 'yes', 'okay', 'ok', 'to', 'of', 'in', 'on',
  'it', 'as', 'at', 'be', 'by', 'or', 'an', 'if', 'so', 'do', 'no',
]);

const MIME_EXTENSIONS: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp3': 'mp3',
  'video/mp4': 'mp4',
};

/** Longest prefix of `terms` that fits `budget` characters once joined with ", ". */
function takeWithin(terms: string[], budget: number, max = Infinity): string[] {
  const taken: string[] = [];
  let used = 0;
  for (const term of terms) {
    const cost = term.length + (taken.length > 0 ? 2 : 0);
    if (taken.length >= max || used + cost > budget) break;
    taken.push(term);
    used += cost;
  }
  return taken;
}

/**
 * Build the `prompt` field: the user's own text, then a comma-separated list
 * of Latin-script terms — the most frequent ones in the transcript history,
 * then the user's keywords. The list is trimmed to fit MAX_PROMPT_CHARS, never
 * the user's text. An empty text sends the list alone; nothing at all gives ''.
 */
export function buildVocabularyHint(
  history: string[] = [],
  customKeywords?: string,
  prompt: string = DEFAULT_TRANSCRIPTION_PROMPT
): string {
  const text = prompt.trim().slice(0, MAX_PROMPT_CHARS);
  const counts = new Map<string, { term: string; count: number }>();
  for (const entry of history) {
    for (const match of entry.match(LATIN_TOKEN) ?? []) {
      const term = match.replace(/[.\-_]+$/, '');
      const key = term.toLowerCase();
      if (term.length < 2 || STOP_WORDS.has(key)) continue;
      const found = counts.get(key);
      if (found) found.count++;
      else counts.set(key, { term, count: 1 });
    }
  }

  const custom = parseCustomKeywords(customKeywords)
    .map((entry) => entry.term)
    .slice(0, MAX_HINT_CUSTOM_TERMS);
  const customKeys = new Set(custom.map((term) => term.toLowerCase()));

  // Array.sort is stable: equal counts keep first-seen order.
  const ranked = [...counts.entries()]
    .filter(([key]) => !customKeys.has(key))
    .sort((a, b) => b[1].count - a[1].count)
    .map(([, entry]) => entry.term);

  // Room for the list: the text, a space after it and the closing dot.
  const budget = MAX_PROMPT_CHARS - (text ? text.length + 1 : 0) - 1;
  // The user's own keywords come first in the budget; history terms fill the rest.
  const customFit = takeWithin(custom, budget);
  const customLength = customFit.join(', ').length;
  const historyFit = takeWithin(
    ranked,
    budget - customLength - (customFit.length > 0 ? 2 : 0),
    MAX_HINT_HISTORY_TERMS
  );

  const list = [...historyFit, ...customFit];
  if (list.length === 0) return text;
  return text ? `${text} ${list.join(', ')}.` : `${list.join(', ')}.`;
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

function isNonRetryableError(error: Error): boolean {
  return error.message.includes('API key') || error.message.includes('Bad request');
}

export interface OpenAIRequestOptions extends TranscribeRequestOptions {
  /** The user's prompt text; undefined means the default, '' means none. */
  transcriptionPrompt?: string;
  /** Past transcripts the vocabulary list is built from. */
  vocabularyHistory?: string[];
}

export async function transcribeWithOpenAI(
  audioBase64: string,
  apiKey: string,
  model: string = DEFAULT_OPENAI_MODEL,
  options?: OpenAIRequestOptions
): Promise<string> {
  const requestSignal = options?.signal;
  const mimeType = options?.mimeType?.split(';')[0] || 'audio/wav';
  const extension = MIME_EXTENSIONS[mimeType] ?? 'wav';
  const audio = base64ToBlob(audioBase64, mimeType);
  const hint = buildVocabularyHint(
    options?.vocabularyHistory,
    options?.customKeywords,
    options?.transcriptionPrompt
  );

  const buildForm = () => {
    const form = new FormData();
    form.append('file', audio, `audio.${extension}`);
    form.append('model', model);
    form.append('response_format', 'json');
    const language = options?.languages?.[0];
    if (language) form.append('language', language);
    if (hint) form.append('prompt', hint);
    return form;
  };

  console.log('[TEST] OpenAI transcription request:', {
    model,
    audioBytes: audio.size,
    hintLength: hint.length,
  });

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const timeoutMs = getTimeoutForAttempt(attempt);
    console.log(`[OpenAI] Attempt ${attempt + 1}/${MAX_ATTEMPTS}, timeout: ${timeoutMs / 1000}s`);

    try {
      if (requestSignal?.aborted) {
        throw new TranscriptionCancelledError();
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const abortHandler = requestSignal ? () => controller.abort() : null;

      if (requestSignal && abortHandler) {
        requestSignal.addEventListener('abort', abortHandler, { once: true });
      }

      try {
        const response = await fetch(TRANSCRIPTIONS_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: buildForm(),
          signal: controller.signal,
        });

        if (response.status === 401 || response.status === 403) {
          const body = await response.text();
          throw new ApiResponseError('Invalid or missing API key', response.status, body);
        }

        if (!response.ok) {
          const body = await response.text();
          let message = response.status < 500 ? 'Bad request' : `HTTP error: ${response.status}`;
          try {
            message = JSON.parse(body).error?.message || message;
          } catch {
            // Response is not JSON (e.g. HTML error page) — keep the default
          }
          throw new ApiResponseError(message, response.status, body);
        }

        const data: { text?: unknown } = await response.json();
        if (typeof data.text !== 'string') {
          throw new Error('Empty response from API');
        }
        return data.text.trim();
      } finally {
        clearTimeout(timeoutId);
        if (requestSignal && abortHandler) {
          requestSignal.removeEventListener('abort', abortHandler);
        }
      }
    } catch (error) {
      if (error instanceof TranscriptionCancelledError || requestSignal?.aborted) {
        throw new TranscriptionCancelledError();
      }

      lastError = error as Error;
      console.error(`[OpenAI] Attempt ${attempt + 1} failed:`, lastError);

      if (isNonRetryableError(lastError)) {
        throw lastError;
      }

      if (attempt < MAX_ATTEMPTS - 1) {
        console.log(`[OpenAI] Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await waitForRetryDelayMs(RETRY_DELAY_MS, requestSignal);
      }
    }
  }

  console.error('[OpenAI] All attempts failed. Final error:', lastError);
  throw lastError || new Error('Transcription failed');
}
