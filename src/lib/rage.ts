/**
 * Nervousness scoring.
 *
 * The question this module answers is not "how loud was that" but "how far
 * from normal was that, for this speaker, on this microphone". Everything is
 * therefore relative to a baseline the speaker builds simply by dictating.
 *
 * The signal is spectral tilt — the slope of the log spectrum. On a labelled
 * set from one speaker, a calm voice held -9.27 dB/kHz with a spread of only
 * ±0.33, while deliberately angry recordings landed four to seven spreads
 * above it. Loudness managed three spreads and pitch overlapped outright.
 *
 * Two properties matter more than the margin:
 *   - Tilt is a slope, so a constant gain offset cancels. A microphone that
 *     rides its own gain (the tested Bluetooth headset moves 7-8 dB across a
 *     recording) flattens loudness but cannot flatten spectral shape.
 *   - The absolute value is meaningless across setups. Even two ways of
 *     measuring the same recording disagree by more than a decibel per kHz,
 *     because window functions differ. Only the distance from this speaker's
 *     own baseline, measured the same way, means anything.
 *
 * Nothing here reads a file or a clock: it is arithmetic over numbers the
 * caller supplies, so it can be tested exhaustively.
 */

/** One recording's contribution to the baseline. */
export interface RageSample {
  /** Median spectral tilt in dB per kHz. */
  tiltDbPerKhz: number;
  /** When it was recorded, epoch milliseconds. */
  at: number;
}

export interface RageBaseline {
  /** Typical tilt for this speaker. Median, so angry recordings can't drag it. */
  centre: number;
  /** Typical distance from that centre. Robust, see `spread()`. */
  spread: number;
  /** How many samples it was built from. */
  count: number;
}

export interface RageVerdict {
  /** How many baseline spreads above normal this recording sits. */
  score: number;
  /** True once `score` crosses the threshold. */
  hot: boolean;
  /** Why there is no verdict, when there isn't one. */
  reason?: 'no-tilt' | 'too-short' | 'baseline-too-small';
  baseline: RageBaseline | null;
}

/**
 * How many recordings the baseline remembers. Large enough that a bad hour
 * cannot redefine "normal", small enough to follow a real change — a new
 * microphone, a different room — within a day of ordinary use.
 */
export const BASELINE_WINDOW = 50;

/**
 * Below this the baseline is guesswork and no verdict is given. Ten ordinary
 * recordings is a few minutes of normal work, so this costs the speaker
 * nothing but a short warm-up after a reset.
 */
export const MIN_BASELINE_SAMPLES = 10;

/**
 * Recordings with less speech than this are not judged. Short clips give the
 * median too few spectra to be stable, and a wrong verdict on a two-word
 * throwaway is worse than no verdict.
 */
export const MIN_SPEECH_SECONDS = 1.5;

/**
 * Default threshold, in baseline spreads. On the labelled set every calm
 * recording stayed under +1.2 and every angry one cleared +2.7, so 2 sits in
 * the empty gap between them rather than on top of either group.
 */
export const DEFAULT_THRESHOLD = 2;

/**
 * A spread can collapse to zero — identical values, or a baseline of two.
 * Dividing by it would turn a rounding difference into an infinite score, so
 * it is floored at roughly the calm spread measured on real speech.
 */
export const MIN_SPREAD = 0.2;

/** Middle value of a list. Does not mutate the input. */
export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Typical distance from the median, scaled so that on ordinary bell-shaped
 * data it matches the familiar standard deviation.
 *
 * Used instead of the standard deviation because the baseline is built from
 * whatever the speaker dictates, angry recordings included. A standard
 * deviation would grow with every outburst and quietly raise the bar for the
 * next one; this measure ignores up to half the set being unusual.
 */
export function spread(values: number[]): number {
  if (values.length < 2) return 0;
  const centre = median(values);
  return 1.4826 * median(values.map((v) => Math.abs(v - centre)));
}

/** Build a baseline from the samples, newest last. Older samples are dropped. */
export function buildBaseline(samples: RageSample[]): RageBaseline {
  const recent = samples.slice(-BASELINE_WINDOW);
  const tilts = recent.map((s) => s.tiltDbPerKhz);
  return {
    centre: median(tilts),
    spread: Math.max(spread(tilts), MIN_SPREAD),
    count: recent.length,
  };
}

export interface ScoreInput {
  /** This recording's tilt, or null when it could not be measured. */
  tiltDbPerKhz: number | null;
  /** How much actual speech the recording held. */
  speechSeconds: number;
  /** Every past sample, newest last. */
  history: RageSample[];
  /** In baseline spreads. Defaults to DEFAULT_THRESHOLD. */
  threshold?: number;
}

/**
 * Score one recording against the speaker's own history.
 *
 * A positive score means a harsher voice than usual: tilt rising towards zero
 * is energy moving up the spectrum, which is what strain sounds like.
 */
export function scoreRecording(input: ScoreInput): RageVerdict {
  const { tiltDbPerKhz, speechSeconds, history } = input;
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;

  if (tiltDbPerKhz === null || !Number.isFinite(tiltDbPerKhz)) {
    return { score: 0, hot: false, reason: 'no-tilt', baseline: null };
  }
  if (speechSeconds < MIN_SPEECH_SECONDS) {
    return { score: 0, hot: false, reason: 'too-short', baseline: null };
  }

  const baseline = buildBaseline(history);
  if (baseline.count < MIN_BASELINE_SAMPLES) {
    return { score: 0, hot: false, reason: 'baseline-too-small', baseline };
  }

  const score = (tiltDbPerKhz - baseline.centre) / baseline.spread;
  return { score, hot: score >= threshold, baseline };
}

/**
 * Append a sample and drop what no longer fits the window.
 *
 * Recordings are added whatever their verdict, including the angry ones. That
 * is deliberate: `spread()` shrugs off outliers, and excluding them would let
 * a bad week silently redefine normal in the other direction.
 */
export function appendSample(history: RageSample[], sample: RageSample): RageSample[] {
  return [...history, sample].slice(-BASELINE_WINDOW);
}

/**
 * Map a score onto 0..1 for the live indicator: 0 at or below the speaker's
 * normal, 1 once the threshold is reached.
 *
 * Deliberately linear and clamped. A curve would make small deviations look
 * dramatic, and the whole point of the indicator is that the speaker can trust
 * what it shows and say whether it matches how they actually felt.
 */
export function tensionFraction(score: number, threshold: number = DEFAULT_THRESHOLD): number {
  if (!Number.isFinite(score) || threshold <= 0) return 0;
  return Math.min(1, Math.max(0, score / threshold));
}

/** True once the baseline holds enough recordings to be worth comparing against. */
export function isBaselineUsable(baseline: RageBaseline | null): boolean {
  return !!baseline && baseline.count >= MIN_BASELINE_SAMPLES;
}

/**
 * Live score during a recording, from a rolling tilt against a known baseline.
 * Returns 0 when there is no baseline yet — an unknown must never render as
 * calm-and-verified, and the caller decides how to show "no data".
 */
export function liveTension(
  rollingTiltDbPerKhz: number,
  baseline: RageBaseline | null,
  threshold: number = DEFAULT_THRESHOLD
): number {
  if (!isBaselineUsable(baseline)) return 0;
  if (!Number.isFinite(rollingTiltDbPerKhz)) return 0;
  const score = (rollingTiltDbPerKhz - baseline!.centre) / baseline!.spread;
  return tensionFraction(score, threshold);
}
