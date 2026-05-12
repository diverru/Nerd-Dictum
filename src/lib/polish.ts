/**
 * Polish step for `local-then-gemini` transcription mode.
 *
 * Runs in the main process (CORS-free) and unifies five LLM providers
 * behind Vercel AI SDK's `generateText`. The polish prompt is shared
 * across providers — only the model handle and the credentials change.
 */

import { generateText, type LanguageModel } from 'ai';
import type { SharedV3ProviderOptions } from '@ai-sdk/provider';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LLMProviderId } from '../shared/types';

export interface PolishOptions {
  languages?: string[];
  customKeywords?: string;
  previousTranscripts?: string[];
}

export interface PolishRequest {
  provider: LLMProviderId;
  apiKey: string;
  model: string;
  rawTranscript: string;
  options?: PolishOptions;
}

interface CustomKeywordEntry {
  term: string;
  aliases: string[];
}

function parseCustomKeywords(customKeywords?: string): CustomKeywordEntry[] {
  if (!customKeywords) return [];
  return customKeywords
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const delimiterMatch = line.match(/(=>|->|=)/);
      if (!delimiterMatch || delimiterMatch.index === undefined) {
        return { term: line, aliases: [] };
      }
      const delimiterIndex = delimiterMatch.index;
      const delimiter = delimiterMatch[0];
      const term = line.slice(0, delimiterIndex).trim();
      const aliasPart = line.slice(delimiterIndex + delimiter.length).trim();
      if (!term) return null;
      const aliases = aliasPart
        ? aliasPart.split(/[,;|]/).map((a) => a.trim()).filter(Boolean)
        : [];
      return { term, aliases };
    })
    .filter((entry): entry is CustomKeywordEntry => Boolean(entry));
}

function buildKeywordsSection(customKeywords?: string): string {
  const entries = parseCustomKeywords(customKeywords);
  if (entries.length === 0) return '';
  const lines = entries.map((entry) =>
    entry.aliases.length === 0
      ? `- ${entry.term}`
      : `- ${entry.term} (aliases: ${entry.aliases.join(', ')})`,
  );
  return `\n\nSpelling-correction dictionary (apply ONLY when the speaker literally said one of the entries):\n${lines.join('\n')}\nUse the canonical form on the left. Preserve exact casing. Never insert a dictionary entry that wasn't actually spoken.`;
}

function buildPolishPrompt(rawTranscript: string, options?: PolishOptions): string {
  let prompt = `You are polishing a raw transcript produced by an offline speech-to-text model. Fix obvious recognition errors, restore punctuation, normalize casing of technical terms, and produce clean readable text. You MUST NOT invent words, add commentary, change meaning, or expand abbreviations the speaker did not say. If the raw transcript is empty or whitespace-only, return the empty string.

KNOWN-EMPTY HALLUCINATIONS:
The offline STT this transcript came from has a documented failure mode where it emits a generic English filler phrase when the audio is actually silence — most commonly "Thank you" / "Thank you." / "thanks" / "Bye" / "Hello" / "Okay" / "OK". The user is a Russian/English-speaking developer; a standalone single English filler phrase is NEVER what they actually said when dictating real content. If the entire raw transcript is one of these phrases (with or without trailing punctuation, any casing) — return the empty string. Same applies to single-word generic English interjections that don't fit the surrounding language context.

CRITICAL — preserve original-language technical terms:
- The speaker code-switches between Russian and English. English technical terms MUST stay in English Latin script. NEVER translate them to Russian and NEVER transliterate them in Cyrillic.
- Common offline-STT failure mode: an English word spoken in a Russian sentence gets written in Cyrillic (e.g. "пекедж", "коммит", "реквест", "пуш", "рендер"). Restore the original English spelling: "package", "commit", "request", "push", "render".
- NEVER replace an English term with its Russian translation. If "package" was said, output "package", not "пакет". If "deploy" was said, output "deploy", not "развёртывание". Same for any code identifier, library name, CLI command, file path, or programming jargon.
- Russian words and phrases stay in Russian. Rule: original English → English; original Russian → Russian. Just fix obvious recognition errors within each language.

`;

  if (options?.languages && options.languages.length > 0) {
    prompt += `Primary languages: ${options.languages.join(', ')}. The speaker may mix these.\n\n`;
  }

  prompt += buildKeywordsSection(options?.customKeywords);

  if (options?.previousTranscripts && options.previousTranscripts.length > 0) {
    const escaped = options.previousTranscripts.map((t) =>
      t.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    );
    const orderedTranscripts = [...escaped].reverse();
    const block = orderedTranscripts
      .map((t, i) => `<transcript index="${i + 1}">\n${t}\n</transcript>`)
      .join('\n');
    prompt += `\n<previous_transcripts>\n${block}\n</previous_transcripts>\n\nThe previous_transcripts block is REFERENCE ONLY for disambiguating recurring terms. Do not copy from it.\n`;
  }

  prompt += `\n<raw_transcript>\n${rawTranscript}\n</raw_transcript>\n\nOutput ONLY the polished transcript text. No commentary, no quotes, no XML.`;

  return prompt;
}

// Per-fetch hard deadline for LLM calls. Without this a stuck TCP connection
// (dead peer in undici's pool, slow DNS, TLS handshake reset by an
// intermediary) can hang for 10+ seconds before undici's default connect
// timeout fires, silently inflating polish latency to 15s+. AI SDK retries
// once on AbortError, so worst case is now ~5 + 2s backoff + ~1.5s retry
// ≈ 8.5s. Typical successful call (~1.5s) is unaffected.
const PER_FETCH_TIMEOUT_MS = 5000;

const timedFetch = ((input: URL | RequestInfo, init?: RequestInit) =>
  fetch(input as RequestInfo | URL, {
    ...init,
    signal: AbortSignal.timeout(PER_FETCH_TIMEOUT_MS),
  })) as typeof fetch;

function buildModel(provider: LLMProviderId, apiKey: string, modelId: string): LanguageModel {
  switch (provider) {
    case 'google': {
      const google = createGoogleGenerativeAI({ apiKey, fetch: timedFetch });
      return google(modelId);
    }
    case 'openai': {
      const openai = createOpenAI({ apiKey, fetch: timedFetch });
      return openai(modelId);
    }
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey, fetch: timedFetch });
      return anthropic(modelId);
    }
    case 'groq': {
      const groq = createOpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1', fetch: timedFetch });
      return groq(modelId);
    }
    case 'deepseek': {
      const deepseek = createOpenAI({ apiKey, baseURL: 'https://api.deepseek.com/v1', fetch: timedFetch });
      return deepseek(modelId);
    }
  }
}

// Permissive Google safety settings — without these the default
// BLOCK_MEDIUM_AND_ABOVE thresholds silently swallow polish responses for
// anything that brushes against profanity, sex, violence, etc., which our
// direct Gemini path has always disabled. The AI SDK exposes these via
// providerOptions.google.safetySettings.
const GOOGLE_PERMISSIVE_SAFETY = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
];

export async function polishViaProvider(request: PolishRequest): Promise<string> {
  if (request.rawTranscript.trim().length === 0) return '';
  const prompt = buildPolishPrompt(request.rawTranscript, request.options);
  const model = buildModel(request.provider, request.apiKey, request.model);
  const providerOptions: SharedV3ProviderOptions = {};
  if (request.provider === 'google') {
    providerOptions.google = {
      safetySettings: GOOGLE_PERMISSIVE_SAFETY,
      // Skip thinking phase on capable Gemini models — same as our direct path.
      thinkingConfig: { thinkingBudget: 0 },
    };
  }
  // Match the direct Gemini path: 1 initial + 1 retry max. AI SDK's default
  // is 2 retries (3 attempts) which silently triples latency on flaky calls.
  const result = await generateText({
    model,
    prompt,
    temperature: 0,
    topP: 1,
    maxRetries: 1,
    ...(Object.keys(providerOptions).length > 0 && { providerOptions }),
  });
  return result.text;
}
