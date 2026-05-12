import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();

// MediaRecorder / FileReader live in the browser, not in Bun. Provide
// minimal shims so AudioRecorder.start()/stop() can drive the opus
// encode + base64 path under test.
class MockMediaRecorder {
  static readonly isTypeSupported = (_mime: string): boolean => true;
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly mimeType: string;
  constructor(_stream: unknown, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? 'audio/webm';
  }
  start(): void {
    this.state = 'recording';
  }
  stop(): void {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    queueMicrotask(() => {
      if (this.ondataavailable) {
        const chunk = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], {
          type: this.mimeType,
        });
        this.ondataavailable({ data: chunk });
      }
      this.onstop?.();
    });
  }
}

class MockFileReader {
  result: string | ArrayBuffer | null = null;
  error: Error | null = null;
  onload: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readAsDataURL(blob: Blob): void {
    blob
      .arrayBuffer()
      .then((buf) => {
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        this.result = `data:${blob.type};base64,${btoa(binary)}`;
        this.onload?.({});
      })
      .catch((err) => {
        this.error = err instanceof Error ? err : new Error(String(err));
        this.onerror?.({});
      });
  }
}

(globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = MockMediaRecorder;
(globalThis as unknown as { FileReader: unknown }).FileReader = MockFileReader;
