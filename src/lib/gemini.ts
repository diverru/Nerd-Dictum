/**
 * Google Gemini API client for speech-to-text transcription
 */

// Domain-specific prompts for different speech contexts
const DOMAIN_PROMPTS: Record<string, string> = {
  programming: `Transcribe the provided audio to text. Preserve developer terms faithfully:
code-like tokens, identifiers, acronyms, file paths. Do not invent content.
Output only the final transcript.

Domain hint: programming / developer speech`,

  general: `Transcribe the provided audio to text accurately.
Do not invent content. Output only the final transcript.

Domain hint: general everyday conversation`,

  cooking: `Transcribe the provided audio to text. Pay attention to:
recipe ingredients, cooking techniques, measurements, kitchen equipment.
Do not invent content. Output only the final transcript.

Domain hint: cooking and culinary terms`,

  medical: `Transcribe the provided audio to text. Preserve medical terms faithfully:
diagnoses, medications, symptoms, procedures, anatomical terms.
Do not invent content. Output only the final transcript.

Domain hint: medical and healthcare terminology`,

  legal: `Transcribe the provided audio to text. Preserve legal terms faithfully:
case citations, legal phrases, contract terminology, statutory references.
Do not invent content. Output only the final transcript.

Domain hint: legal terminology`,

  academic: `Transcribe the provided audio to text. Preserve academic terms faithfully:
citations, research terminology, scientific concepts, methodology terms.
Do not invent content. Output only the final transcript.

Domain hint: academic and research speech`,

  business: `Transcribe the provided audio to text. Preserve business terms faithfully:
financial terms, corporate jargon, metrics, KPIs, project management terms.
Do not invent content. Output only the final transcript.

Domain hint: business and corporate speech`,

  creative: `Transcribe the provided audio to text. Preserve creative writing elements:
dialogue, narrative structure, character names, literary terms.
Do not invent content. Output only the final transcript.

Domain hint: creative writing and storytelling`,
};

const DEFAULT_TRANSCRIPTION_PROMPT = DOMAIN_PROMPTS.programming;

// Default keywords always included in prompts
const DEFAULT_KEYWORDS = `CLAUDE.md = Cloud MD
WIX = vix`;

const INITIAL_TIMEOUT_MS = 30000; // 30 seconds for first attempt
const RETRY_TIMEOUT_MS = 120000; // 2 minutes for retry
const MAX_ATTEMPTS = 2; // 1 initial + 1 retry
const RETRY_DELAY_MS = 1000; // 1 second delay before retry
const AUTH_ERROR_STATUSES = new Set([401, 403]);
const CLIENT_ERROR_STATUS_MIN = 400;
const CLIENT_ERROR_STATUS_MAX = 500;

export interface TranscribeOptions {
  languages?: string[];
  speechDomain?: string;
  customDomainHint?: string;
  customKeywords?: string;
  clarificationEnabled?: boolean;
  previousTranscripts?: string[];
}

export interface TranscribeRequestOptions extends TranscribeOptions {
  signal?: AbortSignal;
  mimeType?: string;
}

export interface PolishRequestOptions extends TranscribeOptions {
  signal?: AbortSignal;
}

export class TranscriptionCancelledError extends Error {
  constructor() {
    super('Transcription cancelled');
    this.name = 'TranscriptionCancelledError';
  }
}

export class ApiResponseError extends Error {
  responseBody: string;
  statusCode: number;

  constructor(message: string, statusCode: number, responseBody: string) {
    super(message);
    this.name = 'ApiResponseError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
    finishReason?: string;
    safetyRatings?: Array<{ category: string; probability: string; blocked?: boolean }>;
  }>;
  promptFeedback?: {
    blockReason?: string;
    safetyRatings?: Array<{ category: string; probability: string; blocked?: boolean }>;
  };
  error?: {
    message: string;
    code: number;
  };
}

interface CustomKeywordEntry {
  term: string;
  aliases: string[];
}

function parseCustomKeywords(customKeywords?: string): CustomKeywordEntry[] {
  if (!customKeywords) {
    return [];
  }

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
      if (!term) {
        return null;
      }

      const aliases = aliasPart
        ? aliasPart
            .split(/[,;|]/)
            .map((alias) => alias.trim())
            .filter(Boolean)
        : [];

      return { term, aliases };
    })
    .filter((entry): entry is CustomKeywordEntry => Boolean(entry));
}

function buildCustomKeywordsSection(customKeywords?: string): string {
  // Always include default keywords, then user's custom keywords
  const combinedKeywords = customKeywords
    ? `${DEFAULT_KEYWORDS}\n${customKeywords}`
    : DEFAULT_KEYWORDS;

  const entries = parseCustomKeywords(combinedKeywords);
  if (entries.length === 0) {
    return '';
  }

  const lines = entries.map((entry) => {
    if (entry.aliases.length === 0) {
      return `- ${entry.term}`;
    }
    return `- ${entry.term} (aliases: ${entry.aliases.join(', ')})`;
  });

  return `\n\nSpelling-correction dictionary (apply ONLY when the speaker literally says one of the entries below; do NOT insert any of these terms unless actually spoken):
${lines.join('\n')}
Use the canonical form on the left when the speaker says it or one of its aliases. Preserve exact casing. Never output a dictionary entry if it is not actually spoken in the audio.`;
}

function buildPrompt(options?: TranscribeOptions): string {
  let basePrompt: string;

  // If custom domain with custom hint, build a custom prompt
  if (options?.speechDomain === 'custom' && options?.customDomainHint) {
    basePrompt = `Transcribe the provided audio to text accurately.
Do not invent content. Output only the final transcript.

Domain hint: ${options.customDomainHint}`;
  } else if (options?.speechDomain && DOMAIN_PROMPTS[options.speechDomain]) {
    basePrompt = DOMAIN_PROMPTS[options.speechDomain];
  } else {
    basePrompt = DEFAULT_TRANSCRIPTION_PROMPT;
  }

  let prompt = `IMPORTANT — silence handling:
If the audio is silent, contains no speech, is too short to contain words, is unintelligible, or contains only background noise, your response MUST be exactly the empty string (zero characters).
Do NOT output any keyword, dictionary entry, previous transcript, language hint, or example as a fallback. Empty audio = empty output. No exceptions.

` + basePrompt;

  // Add clarification instruction if enabled (default behavior)
  if (options?.clarificationEnabled !== false) {
    prompt += `\n\nClarification: Clean up speech disfluencies such as "uh", "um", "eh", stutters, false starts, and filler words. Produce clear, readable text while preserving the speaker's intended meaning.`;
  }

  if (options?.languages && options.languages.length > 0) {
    const languageHint = `\n\nPrimary languages: ${options.languages.join(', ')}. The speaker may mix these languages.`;
    prompt += languageHint;
  }

  const customKeywordsSection = buildCustomKeywordsSection(options?.customKeywords);
  if (customKeywordsSection) {
    prompt += customKeywordsSection;
  }

  // Add previous transcripts as context if provided
  if (options?.previousTranscripts && options.previousTranscripts.length > 0) {
    // Escape < and > to prevent injection into XML structure
    const escapedTranscripts = options.previousTranscripts.map(t =>
      t.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    );
    // Present transcripts in chronological order (oldest first)
    // since previousTranscripts array is newest-first
    const orderedTranscripts = [...escapedTranscripts].reverse();
    const transcriptsBlock = orderedTranscripts
      .map((t, i) => `<transcript index="${i + 1}">\n${t}\n</transcript>`)
      .join('\n');
    prompt += `\n\n<previous_transcripts>
${transcriptsBlock}
</previous_transcripts>

The previous_transcripts block above is REFERENCE ONLY — it shows recent past transcriptions so you can disambiguate technical terms and resolve mid-sentence references. Use it ONLY to disambiguate.

CRITICAL RULES for the current audio:
- Transcribe ONLY what is actually spoken in the audio file attached to THIS request.
- If the audio is silent, contains no intelligible speech, or is too short, output the empty string and nothing else.
- NEVER copy, repeat, paraphrase, or continue text from previous_transcripts unless the speaker literally repeats those words in the new audio.
- Do not hallucinate. If unsure, output empty string.`;
  }

  prompt += `\n\nFINAL REMINDER: Empty audio → empty output. Never output a keyword, alias, language name, previous transcript, hint, or any other piece of this prompt as a fallback. The ONLY allowed outputs are: (a) the literal words spoken, or (b) the empty string.`;

  return prompt;
}

const PERMISSIVE_SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
];

function buildRequestBody(prompt: string, audioBase64: string, mimeType: string = 'audio/wav') {
  return {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: mimeType,
              data: audioBase64,
            },
          },
        ],
      },
    ],
    safetySettings: PERMISSIVE_SAFETY_SETTINGS,
    generationConfig: {
      // Greedy decoding — no sampling search, faster and deterministic.
      temperature: 0,
      topP: 1,
      // For Gemini 2.5/3 thinking-capable models: skip the thinking phase.
      // No-op on lite/flash variants that don't think; harmless either way.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
}

function extractTranscript(data: GeminiResponse): string {
  if (data.error) {
    throw new Error(data.error.message);
  }

  // Prompt-level block (e.g. PROHIBITED_CONTENT safety filter)
  if (data.promptFeedback?.blockReason) {
    const reason = data.promptFeedback.blockReason;
    throw new Error(
      `Transcription failed: blocked by safety filter (${reason}). ` +
      `Try a different model (e.g. gemini-2.5-flash) or adjust prompt/keywords.`
    );
  }

  // Candidate-level block (finishReason = SAFETY / PROHIBITED_CONTENT / etc.)
  const candidate = data.candidates?.[0];
  if (candidate?.finishReason && candidate.finishReason !== 'STOP' && !candidate.content?.parts?.length) {
    throw new Error(
      `Transcription failed: model stopped with finishReason=${candidate.finishReason}. ` +
      `Try a different model or adjust prompt.`
    );
  }

  const text = candidate?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('Empty response from API');
  }

  return text.trim();
}

function isNonRetryableError(error: Error): boolean {
  return (
    error.message.includes('API key') ||
    error.message.includes('Bad request')
  );
}

function getTimeoutForAttempt(attempt: number): number {
  return attempt === 0 ? INITIAL_TIMEOUT_MS : RETRY_TIMEOUT_MS;
}

function waitForRetryDelayMs(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  if (signal.aborted) {
    return Promise.reject(new TranscriptionCancelledError());
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
      reject(new TranscriptionCancelledError());
    };
    const timeoutId = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isSafetyBlockError(error: Error): boolean {
  const msg = error.message || '';
  return (
    msg.includes('blocked by safety filter') ||
    msg.includes('finishReason=SAFETY') ||
    msg.includes('finishReason=PROHIBITED_CONTENT')
  );
}

export async function transcribeAudio(
  audioBase64: string,
  apiKey: string,
  model: string = 'gemini-3-flash-preview',
  options?: TranscribeRequestOptions
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const requestSignal = options?.signal;

  let currentOptions: TranscribeRequestOptions | undefined = options;
  let prompt = buildPrompt(currentOptions);
  let requestBody = buildRequestBody(prompt, audioBase64, currentOptions?.mimeType);
  let droppedContextForSafety = false;

  console.log('[TEST] Gemini transcription request:', {
    model,
    promptLength: prompt.length,
    previousTranscriptsCount: currentOptions?.previousTranscripts?.length ?? 0,
  });

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const timeoutMs = getTimeoutForAttempt(attempt);
    console.log(`[Gemini] Attempt ${attempt + 1}/${MAX_ATTEMPTS}, timeout: ${timeoutMs / 1000}s`);

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
        if (requestSignal?.aborted) {
          throw new TranscriptionCancelledError();
        }

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        if (AUTH_ERROR_STATUSES.has(response.status)) {
          const body = await response.text();
          throw new ApiResponseError('Invalid or missing API key', response.status, body);
        }

        if (
          response.status >= CLIENT_ERROR_STATUS_MIN &&
          response.status < CLIENT_ERROR_STATUS_MAX
        ) {
          const body = await response.text();
          let message = 'Bad request';
          try {
            const errorData = JSON.parse(body);
            message = errorData.error?.message || message;
          } catch {
            // Response is not JSON (e.g. HTML error page) — keep raw body
          }
          throw new ApiResponseError(message, response.status, body);
        }

        if (!response.ok) {
          const body = await response.text();
          throw new ApiResponseError(`HTTP error: ${response.status}`, response.status, body);
        }

        const data: GeminiResponse = await response.json();

        return extractTranscript(data);
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

      const errDetails: Record<string, unknown> = {
        name: lastError.name,
        message: lastError.message,
      };
      if (lastError instanceof ApiResponseError) {
        errDetails.statusCode = lastError.statusCode;
        errDetails.responseBody = lastError.responseBody?.slice(0, 2000);
      }
      console.error(`[Gemini] Attempt ${attempt + 1} failed:`, errDetails, lastError);

      // Don't retry on auth errors or bad requests
      if (isNonRetryableError(lastError)) {
        throw lastError;
      }

      // Safety filter triggered — drop previous_transcripts context and retry
      // immediately (don't waste a full delay). Only try this once per call.
      if (
        isSafetyBlockError(lastError) &&
        !droppedContextForSafety &&
        (currentOptions?.previousTranscripts?.length ?? 0) > 0
      ) {
        console.warn(
          '[Gemini] Safety filter triggered — flushing previous_transcripts context and retrying'
        );
        droppedContextForSafety = true;
        currentOptions = { ...currentOptions, previousTranscripts: [] };
        prompt = buildPrompt(currentOptions);
        requestBody = buildRequestBody(prompt, audioBase64, currentOptions.mimeType);

        if (attempt < MAX_ATTEMPTS - 1) {
          // No delay — we're retrying with a different body, not waiting on a flaky network
          continue;
        }
      }

      if (attempt < MAX_ATTEMPTS - 1) {
        console.log(`[Gemini] Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await waitForRetryDelayMs(RETRY_DELAY_MS, requestSignal);
      }
    }
  }

  console.error('[Gemini] All attempts failed. Final error:', lastError);
  throw lastError || new Error('Transcription failed');
}

/**
 * Build the polish prompt — used when a local ASR (Parakeet TDT v3) has
 * already transcribed the audio and we just want Gemini to clean up the
 * raw text. The prompt MUST forbid invention/expansion and be tolerant of
 * the empty string passing straight through.
 */
function buildPolishPrompt(rawTranscript: string, options?: TranscribeOptions): string {
  let prompt = `You are polishing a raw transcript produced by an offline speech-to-text model. Your job is to fix obvious recognition errors, restore punctuation, normalize casing of technical terms, and produce clean, readable text. You MUST NOT invent words, add commentary, change the meaning, or expand abbreviations the speaker did not say. If the raw transcript is empty or whitespace-only, return the empty string.

CRITICAL — preserve original-language technical terms:
- The speaker code-switches between Russian and English. English technical terms MUST stay in English Latin script. NEVER translate them to Russian and NEVER transliterate them in Cyrillic.
- Common offline-STT failure mode: an English word spoken in a Russian sentence gets written in Cyrillic transliteration (e.g. "пекедж", "коммит", "реквест", "пуш", "рендер"). Detect these and restore the original English spelling: "package", "commit", "request", "push", "render".
- Even more important: NEVER replace an English term with its Russian translation. If "package" was said, output "package", not "пакет". If "deploy" was said, output "deploy", not "развёртывание". The same applies to any code identifier, library name, CLI command, file path, or programming jargon — keep them in Latin script as the developer would type them.
- Russian words and phrases stay in Russian. The rule is: original English → English; original Russian → Russian. Just fix obvious recognition errors within each language.

`;

  if (options?.languages && options.languages.length > 0) {
    prompt += `Primary languages: ${options.languages.join(', ')}. The speaker may mix these.\n\n`;
  }

  const customKeywordsSection = buildCustomKeywordsSection(options?.customKeywords);
  if (customKeywordsSection) {
    prompt += customKeywordsSection + '\n';
  }

  if (options?.previousTranscripts && options.previousTranscripts.length > 0) {
    const escapedTranscripts = options.previousTranscripts.map((t) =>
      t.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    );
    const orderedTranscripts = [...escapedTranscripts].reverse();
    const transcriptsBlock = orderedTranscripts
      .map((t, i) => `<transcript index="${i + 1}">\n${t}\n</transcript>`)
      .join('\n');
    prompt += `\n<previous_transcripts>\n${transcriptsBlock}\n</previous_transcripts>\n\nThe previous_transcripts block is REFERENCE ONLY for disambiguating recurring terms. Do not copy from it.\n`;
  }

  prompt += `\n<raw_transcript>\n${rawTranscript}\n</raw_transcript>\n\nOutput ONLY the polished transcript text. No commentary, no quotes, no XML.`;

  return prompt;
}

export async function polishTranscript(
  rawTranscript: string,
  apiKey: string,
  model: string = 'gemini-3-flash-preview',
  options?: PolishRequestOptions,
): Promise<string> {
  if (rawTranscript.trim().length === 0) return '';

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const prompt = buildPolishPrompt(rawTranscript, options);

  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    safetySettings: PERMISSIVE_SAFETY_SETTINGS,
    generationConfig: {
      temperature: 0,
      topP: 1,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal: options?.signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new ApiResponseError(`HTTP ${response.status}`, response.status, body);
  }

  const data: GeminiResponse = await response.json();
  return extractTranscript(data);
}
