// Compare a direct Gemini fetch vs the @ai-sdk/google path on identical input.
// Captures URL, body, and timing for each so we can see why AI SDK is slow.

import fs from 'fs';
import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

const settings = JSON.parse(
  fs.readFileSync('/Users/diver/Library/Application Support/nerd-dictum/settings.json', 'utf-8')
);
const apiKey = settings.apiKey;
const model = settings.model || 'gemini-3-flash-preview';

const RAW = 'Раз, два, три, четыре, пять. Тест.';

// Mirrors src/lib/polish.ts buildPolishPrompt() with realistic options.
const FULL_PROMPT = (() => {
  let p = `You are polishing a raw transcript produced by an offline speech-to-text model. Fix obvious recognition errors, restore punctuation, normalize casing of technical terms, and produce clean readable text. You MUST NOT invent words, add commentary, change meaning, or expand abbreviations the speaker did not say. If the raw transcript is empty or whitespace-only, return the empty string.

CRITICAL — preserve original-language technical terms:
- The speaker code-switches between Russian and English. English technical terms MUST stay in English Latin script. NEVER translate them to Russian and NEVER transliterate them in Cyrillic.
- Common offline-STT failure mode: an English word spoken in a Russian sentence gets written in Cyrillic (e.g. "пекедж", "коммит", "реквест", "пуш", "рендер"). Restore the original English spelling: "package", "commit", "request", "push", "render".
- NEVER replace an English term with its Russian translation. If "package" was said, output "package", not "пакет". If "deploy" was said, output "deploy", not "развёртывание". Same for any code identifier, library name, CLI command, file path, or programming jargon.
- Russian words and phrases stay in Russian. Rule: original English → English; original Russian → Russian. Just fix obvious recognition errors within each language.

`;
  p += `Primary languages: en, he, ru. The speaker may mix these.\n\n`;
  p += `\n\nSpelling-correction dictionary (apply ONLY when the speaker literally said one of the entries):\n- CLAUDE.md (aliases: Cloud MD)\n- WIX (aliases: vix)\nUse the canonical form on the left. Preserve exact casing. Never insert a dictionary entry that wasn't actually spoken.\n`;
  // Simulate ~10 previous transcripts of typical length.
  const fakePrev = Array.from({ length: 10 }, (_, i) =>
    `<transcript index="${i + 1}">\nЗдесь какой-то предыдущий транскрипт номер ${i + 1}, обычной длины, чтобы прикинуть размер блока context'а в полном промпте.\n</transcript>`
  ).join('\n');
  p += `\n<previous_transcripts>\n${fakePrev}\n</previous_transcripts>\n\nThe previous_transcripts block is REFERENCE ONLY for disambiguating recurring terms. Do not copy from it.\n`;
  p += `\n<raw_transcript>\n${RAW}\n</raw_transcript>\n\nOutput ONLY the polished transcript text. No commentary, no quotes, no XML.`;
  return p;
})();
console.log('full prompt size:', FULL_PROMPT.length, 'ch');
const PROMPT = FULL_PROMPT;

// ---- Wrap global fetch to log every outgoing call -------------------
const origFetch = globalThis.fetch;
globalThis.fetch = async function(url, init) {
  const t0 = Date.now();
  const u = typeof url === 'string' ? url : url.toString();
  const tag = u.includes('generativelanguage') ? '[FETCH]' : '[fetch-other]';
  console.log(`${tag} → POST ${u}`);
  if (init?.body) {
    const body = typeof init.body === 'string' ? init.body : '<binary>';
    console.log(`${tag} body (${body.length}ch):`, body.slice(0, 600));
  }
  const r = await origFetch.call(globalThis, url, init);
  const ttfb = Date.now() - t0;
  // Don't read body here; consumer will read it. We only know headers.
  console.log(`${tag} ← ${r.status} ttfb=${ttfb}ms`);
  return r;
};

// ---- Direct Gemini call ----------------------------------------------
async function direct() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: PROMPT }] }],
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
    ],
    generationConfig: {
      temperature: 0,
      topP: 1,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  const t0 = Date.now();
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  const elapsed = Date.now() - t0;
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return { elapsed, text, raw: data };
}

// ---- AI SDK call -----------------------------------------------------
async function viaSdk() {
  const google = createGoogleGenerativeAI({ apiKey });
  const t0 = Date.now();
  const result = await generateText({
    model: google(model),
    prompt: PROMPT,
    temperature: 0,
    topP: 1,
    maxRetries: 1,
    providerOptions: {
      google: {
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
        ],
        thinkingConfig: { thinkingBudget: 0 },
      },
    },
  });
  return { elapsed: Date.now() - t0, text: result.text, finishReason: result.finishReason, usage: result.usage };
}

// silence per-call fetch dump for the multi-trial summary
globalThis.fetch = origFetch;

const trials = [];
for (let i = 0; i < 3; i++) {
  const d = await direct();
  trials.push({ kind: 'direct', i, ms: d.elapsed, len: d.text.length });
  const a = await viaSdk();
  trials.push({ kind: 'sdk   ', i, ms: a.elapsed, len: a.text.length });
}

console.log('\n=== Summary ===');
for (const t of trials) console.log(`${t.kind} #${t.i}: ${t.ms} ms (out=${t.len}ch)`);
const avg = (kind) => {
  const xs = trials.filter(t => t.kind === kind).map(t => t.ms);
  return Math.round(xs.reduce((a,b)=>a+b,0) / xs.length);
};
console.log('avg direct:', avg('direct'), 'ms');
console.log('avg sdk   :', avg('sdk   '), 'ms');
process.exit(0);

console.log('=== DIRECT fetch ===');
const d = await direct();
console.log('direct elapsed:', d.elapsed, 'ms, textLen:', d.text.length, 'text:', JSON.stringify(d.text));

console.log('\n=== AI SDK ===');
const a = await viaSdk();
console.log('sdk elapsed:', a.elapsed, 'ms, textLen:', a.text.length, 'text:', JSON.stringify(a.text), 'finishReason:', a.finishReason);
console.log('usage:', a.usage);

console.log('\n=== Diff ===');
console.log('direct:', d.elapsed, 'ms');
console.log('sdk   :', a.elapsed, 'ms');
console.log('overhead:', a.elapsed - d.elapsed, 'ms');
