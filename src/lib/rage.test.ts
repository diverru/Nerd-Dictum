import { describe, it, expect } from 'bun:test';
import {
  median,
  spread,
  buildBaseline,
  scoreRecording,
  appendSample,
  BASELINE_WINDOW,
  MIN_BASELINE_SAMPLES,
  MIN_SPEECH_SECONDS,
  MIN_SPREAD,
  DEFAULT_THRESHOLD,
  type RageSample,
} from './rage';

const samples = (tilts: number[]): RageSample[] =>
  tilts.map((tiltDbPerKhz, i) => ({ tiltDbPerKhz, at: 1000 + i }));

// Twelve calm recordings from the labelled set, scattered around -9.3 the way
// real ones were.
const CALM = samples([
  -9.2, -9.4, -9.1, -9.3, -9.6, -9.0, -9.35, -9.25, -9.5, -9.15, -9.45, -9.3,
]);

describe('median', () => {
  it('takes the middle of an odd-length list', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the two middles of an even-length list', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('does not mutate the caller array', () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });

  it('returns NaN for an empty list', () => {
    expect(Number.isNaN(median([]))).toBe(true);
  });
});

describe('spread', () => {
  it('is zero when every value is identical', () => {
    expect(spread([5, 5, 5, 5])).toBe(0);
  });

  it('is zero for a single value — one point has no spread', () => {
    expect(spread([5])).toBe(0);
  });

  it('roughly matches the standard deviation on ordinary data', () => {
    const values = [-9.2, -9.4, -9.1, -9.3, -9.6, -9.0, -9.35, -9.25];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = Math.sqrt(
      values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1)
    );
    expect(spread(values)).toBeGreaterThan(sd * 0.6);
    expect(spread(values)).toBeLessThan(sd * 1.6);
  });

  it('ignores outliers that would inflate a standard deviation', () => {
    const calm = [-9.2, -9.3, -9.25, -9.35, -9.3, -9.2, -9.3];
    const withRage = [...calm, -2, -1, 0];
    // A standard deviation would more than triple here. This barely moves.
    expect(spread(withRage)).toBeLessThan(spread(calm) * 2);
  });
});

describe('buildBaseline', () => {
  it('centres on the typical value', () => {
    expect(buildBaseline(CALM).centre).toBeCloseTo(-9.3, 1);
  });

  it('keeps only the most recent window', () => {
    const many = samples(new Array(BASELINE_WINDOW + 30).fill(-9.3));
    expect(buildBaseline(many).count).toBe(BASELINE_WINDOW);
  });

  it('floors the spread so a flat history cannot divide by zero', () => {
    const identical = samples(new Array(20).fill(-9.3));
    expect(buildBaseline(identical).spread).toBe(MIN_SPREAD);
  });

  it('is not dragged by a run of angry recordings', () => {
    const polluted = [...CALM, ...samples([-7.0, -6.8, -7.2, -6.9])];
    expect(buildBaseline(polluted).centre).toBeCloseTo(buildBaseline(CALM).centre, 0);
  });
});

describe('scoreRecording', () => {
  it('scores a calm recording near zero', () => {
    const v = scoreRecording({ tiltDbPerKhz: -9.3, speechSeconds: 8, history: CALM });
    expect(Math.abs(v.score)).toBeLessThan(1);
    expect(v.hot).toBe(false);
  });

  it('flags a harsher voice as hot', () => {
    // Angry recordings on the labelled set sat 1.5-2.5 dB/kHz above calm.
    const v = scoreRecording({ tiltDbPerKhz: -7.2, speechSeconds: 8, history: CALM });
    expect(v.score).toBeGreaterThan(DEFAULT_THRESHOLD);
    expect(v.hot).toBe(true);
  });

  it('treats a softer-than-usual voice as calm, not as a deviation', () => {
    const v = scoreRecording({ tiltDbPerKhz: -11.5, speechSeconds: 8, history: CALM });
    expect(v.score).toBeLessThan(0);
    expect(v.hot).toBe(false);
  });

  it('refuses to judge a recording with no tilt measurement', () => {
    const v = scoreRecording({ tiltDbPerKhz: null, speechSeconds: 8, history: CALM });
    expect(v.reason).toBe('no-tilt');
    expect(v.hot).toBe(false);
  });

  it('refuses to judge a recording that is too short', () => {
    const v = scoreRecording({
      tiltDbPerKhz: -6,
      speechSeconds: MIN_SPEECH_SECONDS - 0.1,
      history: CALM,
    });
    expect(v.reason).toBe('too-short');
    expect(v.hot).toBe(false);
  });

  it('refuses to judge until the baseline has enough recordings', () => {
    const v = scoreRecording({
      tiltDbPerKhz: -6,
      speechSeconds: 8,
      history: CALM.slice(0, MIN_BASELINE_SAMPLES - 1),
    });
    expect(v.reason).toBe('baseline-too-small');
    expect(v.hot).toBe(false);
    expect(v.baseline!.count).toBe(MIN_BASELINE_SAMPLES - 1);
  });

  it('honours a custom threshold', () => {
    const input = { tiltDbPerKhz: -8.7, speechSeconds: 8, history: CALM };
    expect(scoreRecording({ ...input, threshold: 10 }).hot).toBe(false);
    expect(scoreRecording({ ...input, threshold: 0.5 }).hot).toBe(true);
  });

  it('still separates when the whole scale is shifted', () => {
    // A different microphone, or a different way of measuring the same audio,
    // moves every tilt by a constant. Scores must not care.
    const shift = -1.21;
    const shifted = CALM.map((s) => ({ ...s, tiltDbPerKhz: s.tiltDbPerKhz + shift }));
    const here = scoreRecording({ tiltDbPerKhz: -7.2, speechSeconds: 8, history: CALM });
    const there = scoreRecording({
      tiltDbPerKhz: -7.2 + shift,
      speechSeconds: 8,
      history: shifted,
    });
    expect(there.score).toBeCloseTo(here.score, 6);
  });
});

describe('appendSample', () => {
  it('adds to the end', () => {
    const next = appendSample(CALM, { tiltDbPerKhz: -8.8, at: 9999 });
    expect(next).toHaveLength(CALM.length + 1);
    expect(next[next.length - 1].tiltDbPerKhz).toBe(-8.8);
  });

  it('drops the oldest once the window is full', () => {
    const full = samples(new Array(BASELINE_WINDOW).fill(-9.3));
    const next = appendSample(full, { tiltDbPerKhz: -8.8, at: 9999 });
    expect(next).toHaveLength(BASELINE_WINDOW);
    expect(next[0].at).toBe(full[1].at);
  });

  it('does not mutate the history it was given', () => {
    const before = CALM.length;
    appendSample(CALM, { tiltDbPerKhz: -8.8, at: 9999 });
    expect(CALM).toHaveLength(before);
  });
});
