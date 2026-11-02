import { ApiResponseError, TranscriptionCancelledError } from '../lib/gemini';
import type { CloudRequest } from '../shared/cloud-requests';

export async function requestCloud(request: CloudRequest, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new TranscriptionCancelledError();
  const id = crypto.randomUUID();
  const cancel = () => window.electronAPI.cancelCloudRequest(id);
  // Send first so a subsequent cancellation is ordered after registration in main.
  const pending = window.electronAPI.cloudRequest(id, request);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const result = await pending;
    if (signal?.aborted) throw new TranscriptionCancelledError();
    if (result.ok) return result.text;
    const { error } = result;
    if (error.name === 'TranscriptionCancelledError') throw new TranscriptionCancelledError();
    if (error.statusCode !== undefined) {
      throw new ApiResponseError(error.message, error.statusCode, error.responseBody ?? '');
    }
    const restored = new Error(error.message);
    restored.name = error.name;
    throw restored;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
