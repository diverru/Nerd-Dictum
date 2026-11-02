import { afterEach, describe, expect, it, mock } from 'bun:test';
import { CloudRequestService } from './cloud-requests';
import { requestCloud } from '../renderer/cloud-client';
import { ApiResponseError, TranscriptionCancelledError } from '../lib/gemini';
import type { CloudRequest } from '../shared/cloud-requests';

const originalFetch = globalThis.fetch;
const originalAPI = window.electronAPI;
afterEach(() => {
  globalThis.fetch = originalFetch;
  window.electronAPI = originalAPI;
});

const google: CloudRequest = { kind: 'google', audioBase64: 'YQ==', apiKey: 'test', model: 'gemini-test' };
const openai: CloudRequest = { kind: 'openai', audioBase64: 'YQ==', apiKey: 'test', model: 'stt-test' };

function bridge(service = new CloudRequestService(() => {})) {
  const cancel = mock((id: string) => service.cancel(1, id));
  window.electronAPI = {
    ...originalAPI,
    cloudRequest: (id, request) => service.run(1, id, structuredClone(request)),
    cancelCloudRequest: cancel,
  };
  return { service, cancel };
}

describe('cloud requests across the renderer/main boundary', () => {
  it('runs Gemini, OpenAI upload and polish through the main service', async () => {
    bridge();
    const calls: string[] = [];
    globalThis.fetch = mock(async (input: unknown, init: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('generativelanguage')) {
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini text' }] } }] }));
      }
      if (url.endsWith('/transcriptions')) {
        expect(init.body).toBeInstanceOf(FormData);
        expect((init.body as FormData).get('model')).toBe('stt-test');
        return new Response(JSON.stringify({ text: 'OpenAI text' }));
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Polished text' } }] }));
    }) as unknown as typeof fetch;
    expect(await requestCloud(google)).toBe('Gemini text');
    expect(await requestCloud(openai)).toBe('OpenAI text');
    expect(await requestCloud({ kind: 'polish', text: 'raw', options: {
      enabled: true, mode: 'cloud', provider: 'openai', apiKey: 'test', minChars: 0,
    } })).toBe('Polished text');
    expect(calls).toHaveLength(3);
  });

  it('preserves API status and response body for the error detail screen', async () => {
    bridge();
    globalThis.fetch = mock(async () => new Response('denied', { status: 403 })) as unknown as typeof fetch;
    try {
      await requestCloud(google);
      throw new Error('Expected API failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiResponseError);
      expect((error as ApiResponseError).statusCode).toBe(403);
      expect((error as ApiResponseError).responseBody).toBe('denied');
    }
  });

  it('cancels an in-flight request without leaving the next request cancelled', async () => {
    const { cancel } = bridge();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    globalThis.fetch = mock((_input: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      started();
    })) as unknown as typeof fetch;
    const controller = new AbortController();
    const result = requestCloud(google, controller.signal);
    await ready;
    controller.abort();
    await expect(result).rejects.toBeInstanceOf(TranscriptionCancelledError);
    expect(cancel).toHaveBeenCalledTimes(1);
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ text: 'next' }))) as unknown as typeof fetch;
    expect(await requestCloud(openai)).toBe('next');
  });

  it('does not send a request if already cancelled', async () => {
    bridge();
    const send = mock(window.electronAPI.cloudRequest);
    window.electronAPI.cloudRequest = send;
    await expect(requestCloud(google, AbortSignal.abort())).rejects.toBeInstanceOf(TranscriptionCancelledError);
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps cancellation scoped to its window and cancels work on window destruction', async () => {
    const service = new CloudRequestService(() => {});
    const signals: AbortSignal[] = [];
    globalThis.fetch = mock((_input: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      signals.push(init.signal!);
      init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })) as unknown as typeof fetch;
    const first = service.run(1, 'same-id', google);
    const second = service.run(2, 'same-id', google);
    service.cancel(1, 'same-id');
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    service.cancelAll(2);
    expect((await first).ok).toBe(false);
    expect((await second).ok).toBe(false);
  });

  it('keeps the raw transcript when polish fails', async () => {
    bridge();
    globalThis.fetch = mock(async () => new Response('failed', { status: 500 })) as unknown as typeof fetch;
    expect(await requestCloud({ kind: 'polish', text: 'raw', options: {
      enabled: true, mode: 'cloud', provider: 'openai', apiKey: 'test', minChars: 0,
    } })).toBe('raw');
  });
});
