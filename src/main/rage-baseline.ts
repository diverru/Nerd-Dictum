/**
 * Persistence for the nervousness baseline.
 *
 * The maths lives in `src/lib/rage.ts` and knows nothing about disk. This file
 * only keeps the samples between runs, in the same place and the same shape as
 * the other small stores (`stats.json`, `transcript-history.json`).
 *
 * The store is deliberately tiny — one number and a timestamp per recording —
 * so it holds no audio and no words, only how harsh the voice sounded.
 */

import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import electronLog from 'electron-log';
import {
  MEASUREMENT_VERSION,
  appendSample,
  buildBaseline,
  qualifiesForBaseline,
  scoreRecording,
  type RageBaseline,
  type RageSample,
  type RageVerdict,
} from '../lib/rage';

function log(...args: unknown[]): void {
  electronLog.info(...args);
}

let history: RageSample[] = [];
let loaded = false;

function storePath(): string {
  return path.join(app.getPath('userData'), 'rage-baseline.json');
}

export function loadRageBaseline(): void {
  try {
    const file = storePath();
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      // A bare array is the version-1 store, whose samples were measured a
      // different way and must not be mixed with the current ones.
      const version = Array.isArray(parsed) ? 1 : Number(parsed?.version);
      const samples = Array.isArray(parsed) ? parsed : parsed?.samples;
      if (version !== MEASUREMENT_VERSION) {
        log(
          `[RageBaseline] store is version ${version}, measurement is ` +
            `${MEASUREMENT_VERSION} — starting over`
        );
        history = [];
      } else if (Array.isArray(samples)) {
        history = samples.filter(
          (s): s is RageSample =>
            typeof s?.tiltDbPerKhz === 'number' &&
            Number.isFinite(s.tiltDbPerKhz) &&
            typeof s?.at === 'number'
        );
        log('[RageBaseline] loaded', history.length, 'samples');
      }
    }
  } catch (error) {
    // A corrupt store must not stop the app starting — an empty baseline just
    // means no verdicts until it refills.
    log('[RageBaseline] failed to load:', error);
    history = [];
  }
  loaded = true;
}

function save(): void {
  try {
    fs.writeFileSync(
      storePath(),
      JSON.stringify({ version: MEASUREMENT_VERSION, samples: history }),
      'utf-8'
    );
  } catch (error) {
    log('[RageBaseline] failed to save:', error);
  }
}

/**
 * Score one recording, then fold it into the baseline.
 *
 * Scoring happens BEFORE the sample is added, so a recording is never
 * compared against a baseline that already contains it.
 */
export function recordAndScore(
  tiltDbPerKhz: number | null,
  recordingSeconds: number,
  speechSeconds: number,
  threshold?: number
): RageVerdict {
  if (!loaded) loadRageBaseline();

  const verdict = scoreRecording({
    tiltDbPerKhz,
    recordingSeconds,
    speechSeconds,
    history,
    threshold,
  });

  // Short recordings are neither judged nor remembered: their tilt is noisy,
  // and that noise would widen the baseline spread and blunt later verdicts.
  if (qualifiesForBaseline(tiltDbPerKhz, recordingSeconds)) {
    history = appendSample(history, { tiltDbPerKhz: tiltDbPerKhz as number, at: Date.now() });
    save();
  }

  return verdict;
}

/** Forget everything. For a new microphone, or a baseline gone wrong. */
export function resetRageBaseline(): void {
  history = [];
  save();
  log('[RageBaseline] reset');
}

/** The current baseline, for the live indicator during recording. */
export function getRageBaseline(): RageBaseline {
  if (!loaded) loadRageBaseline();
  return buildBaseline(history);
}

export function getRageHistoryCount(): number {
  if (!loaded) loadRageBaseline();
  return history.length;
}
