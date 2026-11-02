import { transcribeAudio, ApiResponseError, TranscriptionCancelledError } from '../lib/gemini';
import { transcribeWithOpenAI } from '../lib/openai-stt';
import { polishTranscript } from '../lib/polish';
import type { CloudRequest, CloudResult } from '../shared/cloud-requests';

export class CloudRequestService {
  private readonly pending = new Map<number, Map<string, AbortController>>();

  constructor(private readonly log: (message: string) => void) {}

  async run(owner: number, id: string, request: CloudRequest): Promise<CloudResult> {
    const controller = new AbortController();
    let requests = this.pending.get(owner);
    if (!requests) this.pending.set(owner, requests = new Map());
    if (requests.has(id)) return { ok: false, error: { name: 'Error', message: 'Duplicate cloud request ID' } };
    requests.set(id, controller);
    try {
      let text: string;
      switch (request.kind) {
        case 'google':
          text = await transcribeAudio(request.audioBase64, request.apiKey, request.model, {
            ...request.options, signal: controller.signal,
          });
          break;
        case 'openai':
          text = await transcribeWithOpenAI(request.audioBase64, request.apiKey, request.model, {
            ...request.options, signal: controller.signal,
          });
          break;
        case 'polish':
          text = await polishTranscript(request.text, {
            ...request.options, signal: controller.signal, onLog: this.log,
          });
          break;
        default:
          throw new Error('Unknown cloud request');
      }
      // Polish deliberately falls back to raw text on abort; cancellation still wins at the IPC boundary.
      if (controller.signal.aborted) throw new TranscriptionCancelledError();
      return { ok: true, text };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return { ok: false, error: {
        name: err.name, message: err.message,
        ...(err instanceof ApiResponseError && { statusCode: err.statusCode, responseBody: err.responseBody }),
      } };
    } finally {
      requests.delete(id);
      if (requests.size === 0) this.pending.delete(owner);
    }
  }

  cancel(owner: number, id: string): void {
    this.pending.get(owner)?.get(id)?.abort();
  }

  cancelAll(owner: number): void {
    for (const controller of this.pending.get(owner)?.values() ?? []) controller.abort();
  }
}
