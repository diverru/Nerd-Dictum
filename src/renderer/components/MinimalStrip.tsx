import { memo, useRef } from 'react';
import './MinimalStrip.css';

export type MinimalStripState = 'idle' | 'recording' | 'transcribing' | 'polishing' | 'success' | 'error';

interface MinimalStripProps {
  state: MinimalStripState;
  /** Audio level from 0 to 1 */
  level: number;
}

const MIN_PEAK_DB = -26; // floor for the ceiling, so silence cannot blow up the scale
const HEADROOM_DB = 6; // the loudest recent peak should not sit at the very top
const RANGE_DB = 36; // how much of the range the screen shows
const RELEASE_DB_PER_SEC = 0.3; // ~18 dB a minute back down after a shout
const ATTACK_DB_PER_SEC = 36; // the ceiling follows a new peak fast but not instantly, so a spike still reaches the top

export function toDb(level: number): number {
  return level <= 0 ? -Infinity : 20 * Math.log10(level);
}

/**
 * The recent peak follows the level up at a limited rate and slides back down slowly.
 * Without the rate limit the ceiling would track every spike instantly and the level
 * could never reach the top of the screen.
 */
export function nextPeakDb(prevPeakDb: number, levelDb: number, elapsedMs: number): number {
  const seconds = elapsedMs / 1000;
  if (levelDb > prevPeakDb) {
    return Math.min(levelDb, prevPeakDb + seconds * ATTACK_DB_PER_SEC);
  }
  return Math.max(MIN_PEAK_DB, prevPeakDb - seconds * RELEASE_DB_PER_SEC);
}

/** Level in dB -> 0..1 on a screen that spans RANGE_DB below the peak plus headroom. */
export function scaleFromPeak(levelDb: number, peakDb: number): number {
  const ceiling = peakDb + HEADROOM_DB;
  const floor = ceiling - RANGE_DB;
  return Math.max(0, Math.min(1, (levelDb - floor) / RANGE_DB));
}

/**
 * Vertical mixer-style meter: a fixed housing with a recessed screen. The screen
 * carries the status colour; while recording a gradient fill shows the audio level,
 * auto-scaled to the loudest recent peak.
 */
export const MinimalStrip = memo(function MinimalStrip({ state, level }: MinimalStripProps) {
  const peakRef = useRef({ peakDb: MIN_PEAK_DB, at: Date.now() });

  // Recomputed on each render: the level callback fires continuously while recording.
  let fillStyle: React.CSSProperties | undefined;
  if (state === 'recording') {
    const now = Date.now();
    const levelDb = toDb(level);
    const peakDb = nextPeakDb(peakRef.current.peakDb, levelDb, now - peakRef.current.at);
    peakRef.current = { peakDb, at: now };
    fillStyle = { ['--level' as string]: `${Math.round(scaleFromPeak(levelDb, peakDb) * 100)}%` };
  }

  return (
    <div className={`minimal-strip ${state}`}>
      <div className="strip-screen">
        <div className="strip-fill" style={fillStyle} />
      </div>
    </div>
  );
});
