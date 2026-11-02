import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  extensionForMimeType,
  buildRecordingFileName,
  pruneFailedRecordings,
  saveFailedRecording,
  MAX_FAILED_RECORDINGS,
} from './failed-recordings';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failed-recordings-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('extensionForMimeType', () => {
  it('maps known audio types', () => {
    expect(extensionForMimeType('audio/wav')).toBe('.wav');
    expect(extensionForMimeType('audio/mp3')).toBe('.mp3');
    expect(extensionForMimeType('audio/ogg')).toBe('.ogg');
    expect(extensionForMimeType('video/mp4')).toBe('.mp4');
  });

  it('strips codec suffixes and is case-insensitive', () => {
    expect(extensionForMimeType('audio/webm;codecs=opus')).toBe('.webm');
    expect(extensionForMimeType('AUDIO/WAV')).toBe('.wav');
  });

  it('falls back to .wav for unknown or missing types', () => {
    expect(extensionForMimeType(undefined)).toBe('.wav');
    expect(extensionForMimeType('application/octet-stream')).toBe('.wav');
  });
});

describe('buildRecordingFileName', () => {
  it('produces a sortable, filesystem-safe name', () => {
    const name = buildRecordingFileName(new Date('2026-08-29T14:32:05.123Z'), 'audio/wav');
    expect(name).toBe('recording-2026-08-29T14-32-05-123Z.wav');
    expect(name).not.toContain(':');
  });
});

describe('saveFailedRecording', () => {
  it('writes the decoded audio to disk and reports its size', () => {
    const base64 = Buffer.from('fake wav bytes').toString('base64');
    const saved = saveFailedRecording(dir, base64, 'audio/wav', new Date('2026-08-29T10:00:00.000Z'));

    expect(fs.existsSync(saved.filePath)).toBe(true);
    expect(fs.readFileSync(saved.filePath).toString()).toBe('fake wav bytes');
    expect(saved.sizeBytes).toBe('fake wav bytes'.length);
    expect(saved.fileName).toBe('recording-2026-08-29T10-00-00-000Z.wav');
  });

  it('creates the directory when it does not exist yet', () => {
    const nested = path.join(dir, 'nope', 'still-nope');
    const saved = saveFailedRecording(nested, Buffer.from('x').toString('base64'));
    expect(fs.existsSync(saved.filePath)).toBe(true);
  });

  it('keeps at most MAX_FAILED_RECORDINGS files, dropping the oldest', () => {
    for (let i = 0; i < MAX_FAILED_RECORDINGS + 5; i++) {
      const when = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
      saveFailedRecording(dir, Buffer.from(`audio-${i}`).toString('base64'), 'audio/wav', when);
    }

    const names = fs.readdirSync(dir).sort();
    expect(names.length).toBe(MAX_FAILED_RECORDINGS);
    // The five oldest (seconds 0..4) are gone; the newest survives.
    expect(names[0]).toBe('recording-2026-01-01T00-00-05-000Z.wav');
    expect(names[names.length - 1]).toBe(`recording-2026-01-01T00-00-${String(MAX_FAILED_RECORDINGS + 4).padStart(2, '0')}-000Z.wav`);
  });
});

describe('pruneFailedRecordings', () => {
  it('does nothing when the directory is missing', () => {
    expect(pruneFailedRecordings(path.join(dir, 'missing'))).toEqual([]);
  });

  it('ignores files that are not recordings', () => {
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me');
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(dir, `recording-2026-01-01T00-00-0${i}-000Z.wav`), 'x');
    }

    const deleted = pruneFailedRecordings(dir, 1);
    expect(deleted.length).toBe(2);
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'recording-2026-01-01T00-00-02-000Z.wav'))).toBe(true);
  });
});
