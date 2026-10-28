import { describe, it, expect } from 'bun:test';
import { render } from '@testing-library/react';
import { MinimalStrip, toDb, nextPeakDb, scaleFromPeak } from './MinimalStrip';

describe('toDb', () => {
  it('converts linear level to dB', () => {
    expect(toDb(1)).toBe(0);
    expect(toDb(0.1)).toBeCloseTo(-20, 5);
    expect(toDb(0)).toBe(-Infinity);
  });
});

describe('nextPeakDb', () => {
  it('slides down 0.3 dB per second while the level stays under the peak', () => {
    expect(nextPeakDb(-10, -40, 10_000)).toBeCloseTo(-13, 5);
  });

  it('never goes below the floor', () => {
    expect(nextPeakDb(-25, -60, 60_000)).toBe(-26);
    expect(nextPeakDb(-26, -60, 1000)).toBe(-26);
  });

  it('rises towards a louder level at a limited rate, so a spike overshoots the screen', () => {
    // 20 dB jump within one 30 ms frame: the ceiling may only move ~1 dB
    expect(nextPeakDb(-30, -10, 30)).toBeCloseTo(-30 + 36 * 0.03, 5);
    expect(scaleFromPeak(-10, nextPeakDb(-30, -10, 30))).toBe(1);
  });

  it('never overshoots the level itself', () => {
    expect(nextPeakDb(-30, -29, 1000)).toBe(-29);
  });
});

describe('scaleFromPeak', () => {
  it('is 0 for silence', () => {
    expect(scaleFromPeak(toDb(0.002), -16)).toBe(0);
    expect(scaleFromPeak(-Infinity, -16)).toBe(0);
  });

  it('puts the peak itself high on the screen, below the headroom', () => {
    // ceiling = peak + 6 dB, so the peak sits 6/36 below the top
    expect(scaleFromPeak(-16, -16)).toBeCloseTo(30 / 36, 5);
  });

  it('clamps above the ceiling and reads the middle in between', () => {
    expect(scaleFromPeak(0, -16)).toBe(1);
    expect(scaleFromPeak(-16 + 6 - 18, -16)).toBeCloseTo(0.5, 5);
  });
});

describe('MinimalStrip', () => {
  it('carries the state class on the housing', () => {
    const { container } = render(<MinimalStrip state="transcribing" level={0} />);
    const root = container.querySelector('.minimal-strip');
    expect(root?.classList.contains('transcribing')).toBe(true);
    expect(container.querySelector('.strip-screen .strip-fill')).toBeTruthy();
  });

  it('puts the level into the fill style while recording', () => {
    const { container } = render(<MinimalStrip state="recording" level={0.15} />);
    const fill = container.querySelector<HTMLElement>('.strip-fill');
    expect(fill?.getAttribute('style')).toMatch(/--level:\s*\d+%/);
  });

  it('sets no level outside recording', () => {
    const { container } = render(<MinimalStrip state="idle" level={0.8} />);
    expect(container.querySelector('.strip-fill')?.getAttribute('style')).toBeNull();
  });
});
