import { describe, it, expect } from 'bun:test';
import { buildVocabularyHint } from './openai-stt';

const PREFIX = 'Разговор русскоязычного разработчика. Английские технические термины пишутся латиницей';

function termsOf(hint: string): string[] {
  return hint.slice(PREFIX.length + 2, -1).split(', ');
}

describe('buildVocabularyHint', () => {
  it('returns a valid sentence for an empty history', () => {
    expect(buildVocabularyHint([])).toBe(`${PREFIX}.`);
    expect(buildVocabularyHint()).toBe(`${PREFIX}.`);
  });

  it('ignores Cyrillic-only text', () => {
    expect(buildVocabularyHint(['привет, как дела'])).toBe(`${PREFIX}.`);
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
    expect(buildVocabularyHint([words]).length).toBeLessThan(700);
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
});
