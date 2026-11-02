import { describe, it, expect, mock, afterEach } from 'bun:test';
import {
  polishTranscript,
  isPolishActive,
  DEFAULT_POLISH_MIN_CHARS,
  DEFAULT_POLISH_MODEL,
  DEFAULT_POLISH_PROMPT,
  type PolishOptions,
} from './polish';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const raw = 'ну вот это короткий текст э-э с git commit';
const base: PolishOptions = {
  enabled: true,
  mode: 'cloud',
  provider: 'openai',
  apiKey: 'sk-test',
  minChars: 0,
};

function answerWith(content: unknown, status = 200) {
  const fetchMock = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status }))
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function bodyOf(fetchMock: ReturnType<typeof answerWith>) {
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(init.body as string) as { model: string; messages: Array<{ role: string; content: string }> };
}

describe('polishTranscript', () => {
  it('uses the answer as it comes, whatever it changed, even for a short text', async () => {
    const fetchMock = answerWith('Это короткий текст с git commit.\n');
    const result = await polishTranscript(raw, base);
    expect(result).toBe('Это короткий текст с git commit.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('sends the transcript as the user message and the instruction from settings', async () => {
    const fetchMock = answerWith('ok');
    await polishTranscript(raw, { ...base, instruction: 'Убери только паразитов.', model: 'my-model' });
    const body = bodyOf(fetchMock);
    expect(body.model).toBe('my-model');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content.startsWith('Убери только паразитов.')).toBe(true);
    expect(body.messages[1]).toEqual({ role: 'user', content: raw });
  });

  it('falls back to the default instruction and model when none are set', async () => {
    for (const instruction of [undefined, '', '   ']) {
      const fetchMock = answerWith('ok');
      await polishTranscript(raw, { ...base, instruction });
      const body = bodyOf(fetchMock);
      expect(body.model).toBe(DEFAULT_POLISH_MODEL);
      expect(body.messages[0].content.startsWith(DEFAULT_POLISH_PROMPT)).toBe(true);
    }
  });

  it('logs the raw transcript before sending the request', async () => {
    const order: string[] = [];
    globalThis.fetch = mock(() => {
      order.push('fetch');
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] })));
    }) as unknown as typeof fetch;
    await polishTranscript(raw, { ...base, onLog: (m) => order.push(m) });
    expect(order[0]).toBe(`[Polish] raw transcript (${raw.length} chars): ${raw}`);
    expect(order[1]).toBe('fetch');
  });

  it('does nothing when disabled, in local mode, for Google or without a key', async () => {
    const fetchMock = answerWith('x');
    for (const override of [
      { enabled: false },
      { mode: 'local' as const },
      { provider: 'google' as const },
      { apiKey: '' },
    ]) {
      const options = { ...base, ...override };
      expect(isPolishActive(options, raw)).toBe(false);
      expect(await polishTranscript(raw, options)).toBe(raw);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isPolishActive(base, raw)).toBe(true);
  });

  describe('minimum length', () => {
    const at = (n: number) => 'a'.repeat(n);

    it('makes no request below the threshold and returns the text untouched', async () => {
      const fetchMock = answerWith('x');
      expect(await polishTranscript(at(56), { ...base, minChars: 57 })).toBe(at(56));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('makes the request at the threshold and above it', async () => {
      const fetchMock = answerWith('polished');
      expect(await polishTranscript(at(57), { ...base, minChars: 57 })).toBe('polished');
      expect(await polishTranscript(at(500), { ...base, minChars: 57 })).toBe('polished');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('polishes everything when the threshold is 0', async () => {
      const fetchMock = answerWith('polished');
      expect(await polishTranscript('a', { ...base, minChars: 0 })).toBe('polished');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('uses the default threshold when none is given', async () => {
      const fetchMock = answerWith('polished');
      const withDefault = { ...base, minChars: undefined };
      await polishTranscript(at(DEFAULT_POLISH_MIN_CHARS - 1), withDefault);
      expect(fetchMock).not.toHaveBeenCalled();
      await polishTranscript(at(DEFAULT_POLISH_MIN_CHARS), withDefault);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('falls back to the raw transcript on an HTTP error', async () => {
    answerWith('ignored', 500);
    expect(await polishTranscript(raw, base)).toBe(raw);
  });

  it('falls back to the raw transcript on an empty answer', async () => {
    answerWith('   ');
    expect(await polishTranscript(raw, base)).toBe(raw);
  });

  it('falls back to the raw transcript when the request throws', async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    expect(await polishTranscript(raw, base)).toBe(raw);
  });

  it('falls back to the raw transcript on timeout', async () => {
    globalThis.fetch = mock((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })
    ) as unknown as typeof fetch;
    expect(await polishTranscript(raw, { ...base, timeoutMs: 20 })).toBe(raw);
  });
});
