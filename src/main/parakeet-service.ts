/**
 * Owns the long-running parakeet-bridge Swift child process.
 *
 * Lazy lifecycle:
 *   - First call to `transcribe()` spawns the daemon and waits for READY.
 *   - Subsequent calls reuse the same process (warm).
 *   - `stop()` is idempotent; on app quit we send {"shutdown": true} and
 *     give the child a moment, otherwise SIGTERM.
 */

import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { spawn, ChildProcessByStdio } from 'child_process';
import type { Readable, Writable } from 'stream';
import { createInterface } from 'readline';

export interface ParakeetTranscribeRequest {
  wavPath: string;
  timeoutMs?: number;
}

export interface ParakeetTranscribeResult {
  text: string;
  elapsedMs: number;
  samples: number;
}

export interface ParakeetStatus {
  state: 'idle' | 'starting' | 'ready' | 'failed';
  error?: string;
  loadDurationMs?: number;
}

interface PendingRequest {
  resolve: (result: ParakeetTranscribeResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

const READY_TIMEOUT_MS = 60_000; // model loads in ~10 s on M-series Mac, give margin
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type ParakeetStatusListener = (status: ParakeetStatus) => void;

export class ParakeetService {
  private child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private status: ParakeetStatus = { state: 'idle' };
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private statusListeners = new Set<ParakeetStatusListener>();
  private readonly log: (message: string) => void;

  constructor(log: (message: string) => void) {
    this.log = log;
  }

  getStatus(): ParakeetStatus {
    return { ...this.status };
  }

  /** Subscribe to status transitions. Returns an unsubscribe function. */
  onStatusChange(listener: ParakeetStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(next: ParakeetStatus): void {
    this.status = next;
    for (const listener of this.statusListeners) {
      try {
        listener({ ...next });
      } catch {
        // ignore listener errors
      }
    }
  }

  /**
   * Ensure the daemon is running and READY. Safe to call repeatedly.
   * If a previous start failed, calling `ensureStarted` again will retry.
   */
  async ensureStarted(): Promise<void> {
    if (this.status.state === 'ready' && this.child) return;
    if (this.status.state === 'starting' && this.readyPromise) {
      return this.readyPromise;
    }

    this.setStatus({ state: 'starting' });
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const timeout = setTimeout(() => {
      const err = new Error(`Parakeet daemon did not become ready within ${READY_TIMEOUT_MS / 1000}s`);
      this.setStatus({ state: 'failed', error: err.message });
      this.readyReject?.(err);
      this.cleanup();
    }, READY_TIMEOUT_MS);

    try {
      this.spawnDaemon();
    } catch (error) {
      clearTimeout(timeout);
      const err = error as Error;
      this.setStatus({ state: 'failed', error: err.message });
      this.readyReject?.(err);
      this.cleanup();
      throw err;
    }

    // The READY signal flips state to 'ready' and resolves readyPromise.
    // The timeout above is the only failure path apart from spawn errors.
    try {
      await this.readyPromise;
    } finally {
      clearTimeout(timeout);
    }
  }

  async transcribe({ wavPath, timeoutMs }: ParakeetTranscribeRequest): Promise<ParakeetTranscribeResult> {
    await this.ensureStarted();
    if (!this.child || !this.child.stdin) {
      throw new Error('Parakeet daemon not running');
    }
    const id = `r${this.nextId++}`;
    const request = JSON.stringify({ id, wav_path: wavPath });
    return new Promise<ParakeetTranscribeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Parakeet transcribe timed out after ${(timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) / 1000}s`));
      }, timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(request + '\n', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.child) {
      this.cleanup();
      return;
    }
    const child = this.child;
    try {
      child.stdin.write(JSON.stringify({ id: 'shutdown', shutdown: true }) + '\n');
      child.stdin.end();
    } catch {
      // ignore — proceed to kill
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.cleanup();
  }

  private spawnDaemon(): void {
    const swiftBinary = this.resolveSwiftBinaryPath();
    if (!fs.existsSync(swiftBinary)) {
      throw new Error(
        `parakeet-bridge binary missing at ${swiftBinary}. ` +
          `Run \`bun run build:swift\` (requires Xcode + Swift toolchain on macOS).`
      );
    }
    this.log(`[Parakeet] spawning Swift bridge: ${swiftBinary}`);
    const child = spawn(swiftBinary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    const stdoutLines = createInterface({ input: child.stdout });
    stdoutLines.on('line', (line) => this.handleStdout(line));

    const stderrLines = createInterface({ input: child.stderr });
    stderrLines.on('line', (line) => this.handleStderr(line));

    child.on('error', (err) => {
      this.log(`[Parakeet] child error: ${err.message}`);
      this.setStatus({ state: 'failed', error: err.message });
      this.readyReject?.(err);
      this.failAllPending(err);
    });
    child.on('exit', (code, signal) => {
      this.log(`[Parakeet] child exited code=${code} signal=${signal}`);
      const wasReady = this.status.state === 'ready';
      this.setStatus(wasReady ? { state: 'idle' } : { state: 'failed', error: `exited code=${code}` });
      this.failAllPending(new Error(`Parakeet daemon exited (code=${code}, signal=${signal})`));
      this.child = null;
    });
  }

  private resolveSwiftBinaryPath(): string {
    // In dev: built via `swift build -c release` inside the repo.
    // In packaged: bundled via electron-builder extraResources.
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'bin', 'parakeet-bridge');
    }
    return path.join(app.getAppPath(), 'swift', '.build', 'release', 'parakeet-bridge');
  }

  private handleStdout(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: { id?: string; ok?: boolean; text?: string; error?: string; elapsed_ms?: number; samples?: number };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.log(`[Parakeet] bad stdout JSON: ${trimmed.slice(0, 200)}`);
      return;
    }
    const id = parsed.id;
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (parsed.ok) {
      pending.resolve({
        text: parsed.text || '',
        elapsedMs: parsed.elapsed_ms || 0,
        samples: parsed.samples || 0,
      });
    } else {
      pending.reject(new Error(parsed.error || 'unknown daemon error'));
    }
  }

  private handleStderr(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.log(`[Parakeet/swift] ${trimmed}`);
    if (trimmed === 'READY') {
      this.setStatus({ state: 'ready' });
      this.readyResolve?.();
    } else if (trimmed.startsWith('MODEL_LOADED in ')) {
      const match = trimmed.match(/MODEL_LOADED in ([\d.]+)s/);
      if (match) {
        this.setStatus({ ...this.status, loadDurationMs: Math.round(parseFloat(match[1]) * 1000) });
      }
    }
  }

  private failAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  private cleanup(): void {
    this.failAllPending(new Error('Parakeet service stopped'));
    this.child = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
  }
}
