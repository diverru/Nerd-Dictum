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

const HINT_PREFIX = 'Разговор русскоязычного разработчика. Английские технические термины пишутся латиницей';
const MAX_HINT_HISTORY_TERMS = 45;
const MAX_HINT_CUSTOM_TERMS = 20;
const MAX_HINT_LIST_CHARS = 500;
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

/**
 * Build the `prompt` field: a short sentence plus a comma-separated list of
 * Latin-script terms: the most frequent ones in the recent transcripts, then
 * the user's own keywords. Bounded in length; an empty history gives the
 * sentence alone.
 */
export function buildVocabularyHint(history: string[] = [], customKeywords?: string): string {
  const counts = new Map<string, { term: string; count: number }>();
  for (const text of history) {
    for (const match of text.match(LATIN_TOKEN) ?? []) {
      const term = match.replace(/[.\-_]+$/, '');
      const key = term.toLowerCase();
      if (term.length < 2 || STOP_WORDS.has(key)) continue;
      const entry = counts.get(key);
      if (entry) entry.count++;
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

  // The user's own keywords always make it in; history terms fill the rest.
  let used = custom.join(', ').length;
  const terms: string[] = [];
  for (const term of ranked) {
    if (terms.length >= MAX_HINT_HISTORY_TERMS || used + term.length + 2 > MAX_HINT_LIST_CHARS) break;
    terms.push(term);
    used += term.length + 2;
  }

  const list = [...terms, ...custom];
  return list.length > 0 ? `${HINT_PREFIX}: ${list.join(', ')}.` : `${HINT_PREFIX}.`;
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

export async function transcribeWithOpenAI(
  audioBase64: string,
  apiKey: string,
  model: string = DEFAULT_OPENAI_MODEL,
  options?: TranscribeRequestOptions
): Promise<string> {
  const requestSignal = options?.signal;
  const mimeType = options?.mimeType?.split(';')[0] || 'audio/wav';
  const extension = MIME_EXTENSIONS[mimeType] ?? 'wav';
  const audio = base64ToBlob(audioBase64, mimeType);
  const hint = buildVocabularyHint(options?.previousTranscripts, options?.customKeywords);

  const buildForm = () => {
    const form = new FormData();
    form.append('file', audio, `audio.${extension}`);
    form.append('model', model);
    form.append('response_format', 'json');
    const language = options?.languages?.[0];
    if (language) form.append('language', language);
    form.append('prompt', hint);
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
