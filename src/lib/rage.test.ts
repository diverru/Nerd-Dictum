import { describe, it, expect } from 'bun:test';
import {
  median,
  spread,
  buildBaseline,
  scoreRecording,
  appendSample,
  BASELINE_WINDOW,
  MIN_BASELINE_SAMPLES,
  MIN_RECORDING_SECONDS,
  MIN_SPREAD,
  DEFAULT_THRESHOLD,
  tensionFraction,
  liveTension,
  isBaselineUsable,
  effectiveSpread,
  qualifiesForBaseline,
  nextStreak,
  shouldBlock,
  MIN_RECORDING_FOR_BASELINE,
  TILT_SLICE_NOISE_K,
  buildBaseline as build,
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
    const v = scoreRecording({ tiltDbPerKhz: -9.3, recordingSeconds: 30, speechSeconds: 12, history: CALM });
    expect(Math.abs(v.score)).toBeLessThan(1);
    expect(v.hot).toBe(false);
  });

  it('flags a harsher voice as hot', () => {
    // Angry recordings on the labelled set sat 1.5-2.5 dB/kHz above calm,
    // over roughly ten seconds of speech each.
    const v = scoreRecording({ tiltDbPerKhz: -7.2, recordingSeconds: 25, speechSeconds: 10, history: CALM });
    expect(v.score).toBeGreaterThan(DEFAULT_THRESHOLD);
    expect(v.hot).toBe(true);
  });

  it('refuses a clip under the ten-second bar outright', () => {
    const v = scoreRecording({
      tiltDbPerKhz: -7.2,
      recordingSeconds: 5,
      speechSeconds: 2,
      history: CALM,
    });
    expect(v.reason).toBe('too-short');
    expect(v.hot).toBe(false);
  });

  it('treats a softer-than-usual voice as calm, not as a deviation', () => {
    const v = scoreRecording({ tiltDbPerKhz: -11.5, recordingSeconds: 30, speechSeconds: 12, history: CALM });
    expect(v.score).toBeLessThan(0);
    expect(v.hot).toBe(false);
  });

  it('refuses to judge a recording with no tilt measurement', () => {
    const v = scoreRecording({ tiltDbPerKhz: null, recordingSeconds: 30, speechSeconds: 12, history: CALM });
    expect(v.reason).toBe('no-tilt');
    expect(v.hot).toBe(false);
  });

  it('refuses to judge a recording that is too short', () => {
    const v = scoreRecording({
      tiltDbPerKhz: -6,
      recordingSeconds: MIN_RECORDING_SECONDS - 0.1,
      speechSeconds: 4,
      history: CALM,
    });
    expect(v.reason).toBe('too-short');
    expect(v.hot).toBe(false);
  });

  it('refuses to judge until the baseline has enough recordings', () => {
    const v = scoreRecording({
      tiltDbPerKhz: -6,
      recordingSeconds: 30, speechSeconds: 12,
      history: CALM.slice(0, MIN_BASELINE_SAMPLES - 1),
    });
    expect(v.reason).toBe('baseline-too-small');
    expect(v.hot).toBe(false);
    expect(v.baseline!.count).toBe(MIN_BASELINE_SAMPLES - 1);
  });

  it('honours a custom threshold', () => {
    const input = { tiltDbPerKhz: -8.7, recordingSeconds: 25, speechSeconds: 10, history: CALM };
    expect(scoreRecording({ ...input, threshold: 10 }).hot).toBe(false);
    expect(scoreRecording({ ...input, threshold: 0.5 }).hot).toBe(true);
  });

  it('still separates when the whole scale is shifted', () => {
    // A different microphone, or a different way of measuring the same audio,
    // moves every tilt by a constant. Scores must not care.
    const shift = -1.21;
    const shifted = CALM.map((s) => ({ ...s, tiltDbPerKhz: s.tiltDbPerKhz + shift }));
    const here = scoreRecording({ tiltDbPerKhz: -7.2, recordingSeconds: 25, speechSeconds: 10, history: CALM });
    const there = scoreRecording({
      tiltDbPerKhz: -7.2 + shift,
      recordingSeconds: 25, speechSeconds: 10,
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

describe('tensionFraction', () => {
  it('is zero at or below normal', () => {
    expect(tensionFraction(0)).toBe(0);
    expect(tensionFraction(-3)).toBe(0);
  });

  it('reaches one at the threshold and stays there', () => {
    expect(tensionFraction(DEFAULT_THRESHOLD)).toBe(1);
    expect(tensionFraction(DEFAULT_THRESHOLD * 5)).toBe(1);
  });

  it('is linear in between — no drama on small deviations', () => {
    expect(tensionFraction(DEFAULT_THRESHOLD / 2)).toBeCloseTo(0.5, 6);
  });

  it('survives a nonsense score or threshold', () => {
    expect(tensionFraction(NaN)).toBe(0);
    expect(tensionFraction(1, 0)).toBe(0);
  });
});

describe('effectiveSpread', () => {
  it('falls towards the baseline spread as speech accumulates', () => {
    const s1 = effectiveSpread(0.33, 1);
    const s4 = effectiveSpread(0.33, 4);
    const s600 = effectiveSpread(0.33, 600);
    expect(s1).toBeGreaterThan(s4);
    expect(s4).toBeGreaterThan(s600);
    // With enough speech the measurement noise all but vanishes and only the
    // speaker's own variation is left.
    expect(s600).toBeCloseTo(0.33, 1);
  });

  it('is dominated by measurement noise on a one-second clip', () => {
    // The whole reason this exists: judged against the raw baseline spread,
    // a one-second clip would score four "spreads" of rage from noise alone.
    expect(effectiveSpread(0.33, 1)).toBeGreaterThan(TILT_SLICE_NOISE_K * 0.9);
  });

  it('never flags a recording with no speech at all', () => {
    expect(effectiveSpread(0.33, 0)).toBe(Infinity);
    expect(effectiveSpread(0.33, -1)).toBe(Infinity);
  });
});

describe('liveTension', () => {
  const baseline = build(CALM);
  const LONG = 30;

  it('reads zero for a voice at the usual tilt', () => {
    expect(liveTension(baseline.centre, baseline, LONG)).toBe(0);
  });

  it('rises as the voice gets harsher', () => {
    const mild = liveTension(baseline.centre + 0.25, baseline, LONG);
    const harsh = liveTension(baseline.centre + 3, baseline, LONG);
    expect(mild).toBeGreaterThan(0);
    expect(harsh).toBeGreaterThan(mild);
    expect(harsh).toBe(1);
  });

  it('is more cautious on a short window than a long one', () => {
    const early = liveTension(baseline.centre + 1.5, baseline, 0.4);
    const settled = liveTension(baseline.centre + 1.5, baseline, 8);
    expect(early).toBeLessThan(settled);
  });

  it('reports zero rather than guessing when there is no baseline', () => {
    expect(liveTension(-6, null, LONG)).toBe(0);
    expect(liveTension(-6, build(CALM.slice(0, 3)), LONG)).toBe(0);
  });
});

describe('isBaselineUsable', () => {
  it('rejects a missing baseline', () => {
    expect(isBaselineUsable(null)).toBe(false);
  });

  it('rejects one built from too few recordings', () => {
    expect(isBaselineUsable(build(CALM.slice(0, MIN_BASELINE_SAMPLES - 1)))).toBe(false);
  });

  it('accepts one at the minimum and above', () => {
    expect(isBaselineUsable(build(CALM.slice(0, MIN_BASELINE_SAMPLES)))).toBe(true);
    expect(isBaselineUsable(build(CALM))).toBe(true);
  });
});

describe('qualifiesForBaseline', () => {
  it('accepts an ordinary dictation', () => {
    expect(qualifiesForBaseline(-9.3, 25)).toBe(true);
  });

  it('rejects a recording too short to measure reliably', () => {
    expect(qualifiesForBaseline(-9.3, MIN_RECORDING_FOR_BASELINE - 0.1)).toBe(false);
  });

  it('rejects a recording whose tilt could not be measured', () => {
    expect(qualifiesForBaseline(null, 25)).toBe(false);
    expect(qualifiesForBaseline(NaN, 25)).toBe(false);
  });
});

describe('nextStreak', () => {
  const verdict = (over: Partial<ReturnType<typeof scoreRecording>>) =>
    ({ score: 0, hot: false, baseline: null, ...over }) as ReturnType<typeof scoreRecording>;

  it('counts up on a tense recording', () => {
    expect(nextStreak(2, verdict({ hot: true }))).toBe(3);
  });

  it('resets on a calm one', () => {
    expect(nextStreak(2, verdict({ hot: false }))).toBe(0);
  });

  it('leaves the streak alone when there was no verdict', () => {
    // A two-word "yes" between two furious recordings must not clear the count.
    expect(nextStreak(2, verdict({ reason: 'too-short' }))).toBe(2);
    expect(nextStreak(2, verdict({ reason: 'no-tilt' }))).toBe(2);
    expect(nextStreak(2, verdict({ reason: 'baseline-too-small' }))).toBe(2);
  });
});

describe('shouldBlock', () => {
  it('fires at the configured streak and beyond', () => {
    expect(shouldBlock(3, 3)).toBe(true);
    expect(shouldBlock(4, 3)).toBe(true);
  });

  it('does not fire below it', () => {
    expect(shouldBlock(2, 3)).toBe(false);
  });

  it('never fires when blocking is configured off', () => {
    expect(shouldBlock(99, 0)).toBe(false);
  });
});
