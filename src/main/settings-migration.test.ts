import { describe, it, expect } from 'bun:test';
import { migrateSettings } from './settings-migration';

describe('migrateSettings', () => {
  it('maps gemini to cloud + google and keeps the key', () => {
    const out = migrateSettings({ transcriptionMode: 'gemini', apiKey: 'g-key', model: 'm' });
    expect(out).toEqual({ transcriptionMode: 'cloud', cloudProvider: 'google', apiKey: 'g-key', model: 'm' });
  });

  it('maps local-then-gemini to cloud + openai with the new model and keeps the keys', () => {
    const out = migrateSettings({
      transcriptionMode: 'local-then-gemini',
      polishProvider: 'openai',
      apiKey: 'g-key',
      providerConfigs: { openai: { apiKey: 'o-key', model: 'gpt-6-luna' }, groq: { apiKey: 'q', model: 'x' } },
    });
    expect(out.transcriptionMode).toBe('cloud');
    expect(out.cloudProvider).toBe('openai');
    expect(out.providerConfigs.openai).toEqual({ apiKey: 'o-key', model: 'gpt-transcribe' });
    expect(out.providerConfigs.groq).toEqual({ apiKey: 'q', model: 'x' });
    expect(out.apiKey).toBe('g-key');
    expect('polishProvider' in out).toBe(false);
  });

  it('creates the openai entry when none was stored', () => {
    const out = migrateSettings({ transcriptionMode: 'local-then-gemini' });
    expect(out.providerConfigs.openai).toEqual({ apiKey: '', model: 'gpt-transcribe' });
  });

  it('maps local-only to local', () => {
    expect(migrateSettings({ transcriptionMode: 'local-only' }).transcriptionMode).toBe('local');
  });

  it('leaves current settings alone', () => {
    const current = { transcriptionMode: 'cloud', cloudProvider: 'openai', providerConfigs: { openai: { apiKey: 'k', model: 'gpt-transcribe' } } };
    expect(migrateSettings(current)).toEqual(current);
  });

  it('drops settings of removed features', () => {
    const out = migrateSettings({ wakeWordEnabled: true, wakeWordKeyword: 'a', wakeWordThreshold: 1, wakeWordPressEnter: true, nervousness: {}, apiKey: 'k' });
    expect(out).toEqual({ apiKey: 'k' });
  });
});
