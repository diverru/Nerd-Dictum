/**
 * Persistence for recordings whose transcription failed.
 *
 * A 503 from Gemini used to throw away a long dictation: the audio only lived
 * in a renderer ref and was dropped on the next recording. Here it is written
 * to disk so the error window can link to it and retry it later.
 *
 * Deliberately free of `electron` imports so it stays unit-testable — the
 * caller passes the directory in.
 */

import path from 'path';
import fs from 'fs';

export const FAILED_RECORDINGS_DIR_NAME = 'failed-recordings';

/** How many failed recordings to keep on disk before the oldest are deleted. */
export const MAX_FAILED_RECORDINGS = 20;

export interface SavedRecording {
  filePath: string;
  fileName: string;
  sizeBytes: number;
}

const MIME_EXTENSIONS: Record<string, string> = {
  'audio/wav': '.wav',
  'audio/wave': '.wav',
  'audio/x-wav': '.wav',
  'audio/mp3': '.mp3',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/webm': '.webm',
  'video/mp4': '.mp4',
  'audio/mp4': '.m4a',
};

/** File extension for an audio mime type; falls back to `.wav`. */
export function extensionForMimeType(mimeType?: string): string {
  if (!mimeType) return '.wav';
  const bare = mimeType.split(';')[0].trim().toLowerCase();
  return MIME_EXTENSIONS[bare] || '.wav';
}

/** Sortable, filesystem-safe name like `recording-2026-08-29T14-32-05-123Z.wav`. */
export function buildRecordingFileName(date: Date, mimeType?: string): string {
  const stamp = date.toISOString().replace(/[:.]/g, '-');
  return `recording-${stamp}${extensionForMimeType(mimeType)}`;
}

function listRecordings(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith('recording-'))
    .sort(); // ISO timestamps sort chronologically
}

/**
 * Delete the oldest recordings so at most `keep` remain.
 * Returns the names that were deleted.
 */
export function pruneFailedRecordings(dir: string, keep: number = MAX_FAILED_RECORDINGS): string[] {
  if (!fs.existsSync(dir)) return [];
  const names = listRecordings(dir);
  if (names.length <= keep) return [];

  const doomed = names.slice(0, names.length - keep);
  const deleted: string[] = [];
  for (const name of doomed) {
    try {
      fs.unlinkSync(path.join(dir, name));
      deleted.push(name);
    } catch {
      // A file we cannot delete is not worth failing the save over.
    }
  }
  return deleted;
}

/**
 * Write base64 audio into `dir` and prune old entries.
 * Throws if the write fails — the caller decides how loud that should be.
 */
export function saveFailedRecording(
  dir: string,
  audioBase64: string,
  mimeType?: string,
  now: Date = new Date(),
): SavedRecording {
  fs.mkdirSync(dir, { recursive: true });

  const fileName = buildRecordingFileName(now, mimeType);
  const filePath = path.join(dir, fileName);
  const buffer = Buffer.from(audioBase64, 'base64');
  fs.writeFileSync(filePath, buffer);

  pruneFailedRecordings(dir);

  return { filePath, fileName, sizeBytes: buffer.length };
}
