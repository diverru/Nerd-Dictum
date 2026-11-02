import { describe, it, expect } from 'bun:test';
import { buildVocabularyHint, DEFAULT_TRANSCRIPTION_PROMPT } from './openai-stt';

// The default text, a space, the list, a closing dot.
function termsOf(hint: string, prompt: string = DEFAULT_TRANSCRIPTION_PROMPT): string[] {
  return hint.slice(prompt.length + 1, -1).split(', ');
}

describe('buildVocabularyHint', () => {
  it('returns a valid sentence for an empty history', () => {
    expect(buildVocabularyHint([])).toBe(DEFAULT_TRANSCRIPTION_PROMPT);
    expect(buildVocabularyHint()).toBe(DEFAULT_TRANSCRIPTION_PROMPT);
  });

  it('ignores Cyrillic-only text', () => {
    expect(buildVocabularyHint(['привет, как дела'])).toBe(DEFAULT_TRANSCRIPTION_PROMPT);
  });

  it('picks up Latin tokens from mixed-language text', () => {
    const hint = buildVocabularyHint(['сделай git commit и push в kubectl']);
    expect(termsOf(hint)).toEqual(['git', 'commit', 'push', 'kubectl']);
  });

  it('keeps identifier punctuation and strips a trailing dot', () => {
    const hint = buildVocabularyHint(['открой CLAUDE.md и node.js. потом C++ и my_var-name']);
    expect(termsOf(hint)).toEqual(['CLAUDE.md', 'node.js', 'C++', 'my_var-name']);
  });

  it('drops stop words regardless of case', () => {
    const hint = buildVocabularyHint(['The last is None, get Full available commit']);
    expect(termsOf(hint)).toEqual(['commit']);
  });

  it('orders by frequency, ties by first appearance', () => {
    const hint = buildVocabularyHint(['alpha beta', 'beta gamma gamma gamma gamma', 'delta beta']);
    expect(termsOf(hint)).toEqual(['gamma', 'beta', 'alpha', 'delta']);
  });

  it('counts different casings as one term', () => {
    const hint = buildVocabularyHint(['Request request REQUEST', 'other']);
    expect(termsOf(hint)).toEqual(['Request', 'other']);
  });

  it('limits the number of history terms', () => {
    const words = Array.from({ length: 100 }, (_, i) => `w${i}x`).join(' ');
    expect(termsOf(buildVocabularyHint([words])).length).toBe(45);
  });

  it('bounds the length of the hint', () => {
    const words = Array.from({ length: 100 }, (_, i) => `longterm${i}abcdefghij`).join(' ');
    expect(buildVocabularyHint([words]).length).toBeLessThanOrEqual(1000);
  });

  it('appends the user keywords after history terms, using the term side of aliases', () => {
    const hint = buildVocabularyHint(['commit commit push'], 'WIX = vix\nkubectl');
    expect(termsOf(hint)).toEqual(['commit', 'push', 'WIX', 'kubectl']);
  });

  it('does not repeat a history term that is also a user keyword', () => {
    const hint = buildVocabularyHint(['kubectl apply'], 'Kubectl');
    expect(termsOf(hint)).toEqual(['apply', 'Kubectl']);
  });

  it('keeps user keywords when the history fills the budget', () => {
    const words = Array.from({ length: 100 }, (_, i) => `longterm${i}abcdefghij`).join(' ');
    const hint = buildVocabularyHint([words], 'MyCustomTerm');
    expect(termsOf(hint).at(-1)).toBe('MyCustomTerm');
  });

  it('uses the custom text instead of the default and keeps the list after it', () => {
    const prompt = 'Мой текст.';
    const hint = buildVocabularyHint(['git commit'], undefined, prompt);
    expect(hint).toBe('Мой текст. git, commit.');
    expect(hint).not.toContain('Диктовка');
  });

  it('sends the list alone when the text is empty', () => {
    expect(buildVocabularyHint(['git commit'], undefined, '')).toBe('git, commit.');
    expect(buildVocabularyHint(['git commit'], undefined, '   ')).toBe('git, commit.');
  });

  it('sends nothing when both the text and the list are empty', () => {
    expect(buildVocabularyHint([], undefined, '')).toBe('');
  });

  it('trims the list, not the text, when the text is long', () => {
    const prompt = 'я'.repeat(950);
    const words = Array.from({ length: 100 }, (_, i) => `longterm${i}abcdefghij`).join(' ');
    const hint = buildVocabularyHint([words], undefined, prompt);
    expect(hint.startsWith(`${prompt} `)).toBe(true);
    expect(hint.length).toBeLessThanOrEqual(1000);
    expect(hint.length).toBeGreaterThan(prompt.length + 1);
  });

  it('keeps the text and drops the list when the text fills the budget', () => {
    const prompt = 'я'.repeat(1000);
    expect(buildVocabularyHint(['git commit'], 'kubectl', prompt)).toBe(prompt);
  });

  it('cuts a text longer than the cap', () => {
    expect(buildVocabularyHint(['git'], undefined, 'я'.repeat(1500)).length).toBe(1000);
  });
});
