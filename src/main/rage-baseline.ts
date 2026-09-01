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
  appendSample,
  buildBaseline,
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
      if (Array.isArray(parsed)) {
        history = parsed.filter(
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
    fs.writeFileSync(storePath(), JSON.stringify(history), 'utf-8');
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
  speechSeconds: number,
  threshold?: number
): RageVerdict {
  if (!loaded) loadRageBaseline();

  const verdict = scoreRecording({ tiltDbPerKhz, speechSeconds, history, threshold });

  // Only recordings we would have judged get remembered. A two-word clip has
  // an unstable tilt, and letting it into the baseline would widen the spread
  // and blunt every later verdict.
  if (!verdict.reason || verdict.reason === 'baseline-too-small') {
    if (tiltDbPerKhz !== null && Number.isFinite(tiltDbPerKhz)) {
      history = appendSample(history, { tiltDbPerKhz, at: Date.now() });
      save();
    }
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
