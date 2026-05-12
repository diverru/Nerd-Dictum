import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { transcribeAudio, TranscriptionCancelledError } from './gemini';

describe('transcribeAudio', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should return transcribed text on successful response', async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: '  Hello world  ' }],
          },
        },
      ],
    };

    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
      } as Response)
    ) as unknown as typeof fetch;

    const result = await transcribeAudio('base64audio', 'test-api-key');

    expect(result).toBe('Hello world');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('should throw on invalid API key', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve(JSON.stringify({ error: { message: 'Invalid API key' } })),
      } as Response)
    ) as unknown as typeof fetch;

    await expect(transcribeAudio('base64audio', 'invalid-key')).rejects.toThrow(
      'Invalid or missing API key'
    );
  });

  it('should throw on empty response', async () => {
    const mockResponse = {
      candidates: [],
    };

    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
      } as Response)
    ) as unknown as typeof fetch;

    await expect(transcribeAudio('base64audio', 'test-api-key')).rejects.toThrow(
      'Empty response from API'
    );
  });

  it('should stop retries when aborted by signal', async () => {
    let capturedSignal: AbortSignal | undefined;

    globalThis.fetch = mock((_url, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      capturedSignal = signal;
      return new Promise((_resolve, reject) => {
        if (!signal) {
          reject(new Error('Missing abort signal'));
          return;
        }
        if (signal.aborted) {
          reject(signal.reason ?? new Error('Aborted'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            reject(signal.reason ?? new Error('Aborted'));
          },
          { once: true }
        );
      }) as Promise<Response>;
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    const promise = transcribeAudio(
      'base64audio',
      'test-api-key',
      'gemini-3-flash-preview',
      { signal: controller.signal }
    );

    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(TranscriptionCancelledError);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('should include custom keywords in prompt', async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: 'Hello world' }],
          },
        },
      ],
    };

    let capturedPrompt = '';

    globalThis.fetch = mock((_url, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      capturedPrompt = body?.contents?.[0]?.parts?.[0]?.text ?? '';
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
      } as Response);
    }) as unknown as typeof fetch;

    await transcribeAudio(
      'base64audio',
      'test-api-key',
      'gemini-3-flash-preview',
      { customKeywords: 'Bun = bull, b u n\nTypeScript' }
    );

    expect(capturedPrompt).toContain('Spelling-correction dictionary');
    expect(capturedPrompt).toContain('- Bun (aliases: bull, b u n)');
    expect(capturedPrompt).toContain('- TypeScript');
  });

  it('should throw on forbidden status (403)', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 403,
        text: () => Promise.resolve(JSON.stringify({ error: { message: 'Forbidden' } })),
      } as Response)
    ) as unknown as typeof fetch;

    await expect(transcribeAudio('base64audio', 'test-key')).rejects.toThrow(
      'Invalid or missing API key'
    );
  });

  it('should throw on bad request (4xx)', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        text: () => Promise.resolve(JSON.stringify({ error: { message: 'Bad request' } })),
      } as Response)
    ) as unknown as typeof fetch;

    await expect(transcribeAudio('base64audio', 'test-key')).rejects.toThrow(
      'Bad request'
    );
  });

  it('should throw generic message on 4xx without error.message', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 422,
        text: () => Promise.resolve(JSON.stringify({})),
      } as Response)
    ) as unknown as typeof fetch;

    await expect(transcribeAudio('base64audio', 'test-key')).rejects.toThrow(
      'Bad request'
    );
  });

  it('should throw on HTTP error (5xx)', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      } as Response)
    ) as unknown as typeof fetch;

    await expect(transcribeAudio('base64audio', 'test-key')).rejects.toThrow(
      'HTTP error: 500'
    );
  });

  it('should throw on API error in response body', async () => {
    const mockResponse = {
      error: {
        message: 'Model overloaded',
        code: 503,
      },
    };

    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
      } as Response)
    ) as unknown as typeof fetch;

    await expect(transcribeAudio('base64audio', 'test-key')).rejects.toThrow(
      'Model overloaded'
    );
  });

  it('should use custom domain hint for custom speech domain', async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: 'Custom domain test' }],
          },
        },
      ],
    };

    let capturedPrompt = '';

    globalThis.fetch = mock((_url, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      capturedPrompt = body?.contents?.[0]?.parts?.[0]?.text ?? '';
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
      } as Response);
    }) as unknown as typeof fetch;

    await transcribeAudio(
      'base64audio',
      'test-api-key',
      'gemini-3-flash-preview',
      { speechDomain: 'custom', customDomainHint: 'aerospace engineering terminology' }
    );

    expect(capturedPrompt).toContain('Domain hint: aerospace engineering terminology');
  });

  it('should use predefined domain prompt for known speech domains', async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: 'Medical test' }],
          },
        },
      ],
    };

    let capturedPrompt = '';

    globalThis.fetch = mock((_url, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      capturedPrompt = body?.contents?.[0]?.parts?.[0]?.text ?? '';
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
      } as Response);
    }) as unknown as typeof fetch;

    await transcribeAudio(
      'base64audio',
      'test-api-key',
      'gemini-3-flash-preview',
      { speechDomain: 'medical' }
    );

    expect(capturedPrompt).toContain('Domain hint: medical and healthcare terminology');
    expect(capturedPrompt).toContain('medications');
  });

  it('should include language hints when provided', async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: 'Multilingual test' }],
          },
        },
      ],
    };

    let capturedPrompt = '';

    globalThis.fetch = mock((_url, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      capturedPrompt = body?.contents?.[0]?.parts?.[0]?.text ?? '';
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
      } as Response);
    }) as unknown as typeof fetch;

    await transcribeAudio(
      'base64audio',
      'test-api-key',
      'gemini-3-flash-preview',
      { languages: ['English', 'Hebrew', 'Russian'] }
    );

    expect(capturedPrompt).toContain('Primary languages: English, Hebrew, Russian');
    expect(capturedPrompt).toContain('may mix these languages');
  });

  it('should disable clarification when clarificationEnabled is false', async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: 'No clarification test' }],
          },
        },
      ],
    };

    let capturedPrompt = '';

    globalThis.fetch = mock((_url, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      capturedPrompt = body?.contents?.[0]?.parts?.[0]?.text ?? '';
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
      } as Response);
    }) as unknown as typeof fetch;

    await transcribeAudio(
      'base64audio',
      'test-api-key',
      'gemini-3-flash-preview',
      { clarificationEnabled: false }
    );

    expect(capturedPrompt).not.toContain('Clarification:');
    expect(capturedPrompt).not.toContain('speech disfluencies');
  });

  it('should retry on network error and succeed on second attempt', async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: 'Success after retry' }],
          },
        },
      ],
    };

    let callCount = 0;

    globalThis.fetch = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('Network error'));
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
      } as Response);
    }) as unknown as typeof fetch;

    const result = await transcribeAudio('base64audio', 'test-api-key');

    expect(result).toBe('Success after retry');
    expect(callCount).toBe(2);
  });

  it('should not retry on API key error', async () => {
    let callCount = 0;

    globalThis.fetch = mock(() => {
      callCount++;
      return Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve(JSON.stringify({ error: { message: 'Invalid API key' } })),
      } as Response);
    }) as unknown as typeof fetch;

    await expect(transcribeAudio('base64audio', 'test-key')).rejects.toThrow(
      'Invalid or missing API key'
    );
    expect(callCount).toBe(1);
  });

  it('should throw TranscriptionCancelledError when signal is pre-aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      transcribeAudio('base64audio', 'test-key', 'gemini-3-flash-preview', {
        signal: controller.signal,
      })
    ).rejects.toBeInstanceOf(TranscriptionCancelledError);
  });

  it('should handle custom keywords with various delimiters', async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: 'Test' }],
          },
        },
      ],
    };

    let capturedPrompt = '';

    globalThis.fetch = mock((_url, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      capturedPrompt = body?.contents?.[0]?.parts?.[0]?.text ?? '';
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
      } as Response);
    }) as unknown as typeof fetch;

    await transcribeAudio(
      'base64audio',
      'test-api-key',
      'gemini-3-flash-preview',
      { customKeywords: 'kubectl => cube control\nnginx -> engine x\nReact = re act' }
    );

    expect(capturedPrompt).toContain('- kubectl (aliases: cube control)');
    expect(capturedPrompt).toContain('- nginx (aliases: engine x)');
    expect(capturedPrompt).toContain('- React (aliases: re act)');
  });

  it('should handle empty lines in custom keywords', async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: 'Test' }],
          },
        },
      ],
    };

    let capturedPrompt = '';

    globalThis.fetch = mock((_url, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      capturedPrompt = body?.contents?.[0]?.parts?.[0]?.text ?? '';
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
      } as Response);
    }) as unknown as typeof fetch;

    await transcribeAudio(
      'base64audio',
      'test-api-key',
      'gemini-3-flash-preview',
      { customKeywords: 'term1\n\nterm2\n  \nterm3' }
    );

    expect(capturedPrompt).toContain('- term1');
    expect(capturedPrompt).toContain('- term2');
    expect(capturedPrompt).toContain('- term3');
  });

  it('should handle custom keywords with multiple aliases separated by different chars', async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: 'Test' }],
          },
        },
      ],
    };

    let capturedPrompt = '';

    globalThis.fetch = mock((_url, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      capturedPrompt = body?.contents?.[0]?.parts?.[0]?.text ?? '';
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
      } as Response);
    }) as unknown as typeof fetch;

    await transcribeAudio(
      'base64audio',
      'test-api-key',
      'gemini-3-flash-preview',
      { customKeywords: 'Kubernetes = cube, k8s; kube | kubernetes' }
    );

    expect(capturedPrompt).toContain('- Kubernetes (aliases: cube, k8s, kube, kubernetes)');
  });
});
