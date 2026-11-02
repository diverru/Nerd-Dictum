import { describe, it, expect, beforeEach } from 'bun:test';
import { sampleMemory, stopMemoryLog, type ProcessMetricLike } from './memory-log';

const metric = (type: string, mb: number, cpu = 0): ProcessMetricLike => ({
  type,
  memory: { workingSetSize: mb * 1024 },
  cpu: { percentCPUUsage: cpu },
});

describe('memory-log', () => {
  beforeEach(() => stopMemoryLog());

  it('writes one grouped line per sample', () => {
    const lines: string[] = [];
    sampleMemory(
      () => [metric('Browser', 98), metric('Tab', 152, 4.1), metric('GPU', 121), metric('Utility', 40), metric('Zygote', 24)],
      (line) => lines.push(line),
    );
    expect(lines).toEqual([
      '[Mem] renderer=152MB main=98MB gpu=121MB other=64MB total=435MB rendererCpu=4.1%',
    ]);
  });

  it('appends WARNING once the renderer is above 800 MB and 3x the first sample', () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    sampleMemory(() => [metric('Browser', 99), metric('Tab', 128)], log);
    sampleMemory(() => [metric('Browser', 99), metric('Tab', 700)], log); // 5x but under 800 MB
    sampleMemory(() => [metric('Browser', 99), metric('Tab', 3072, 96)], log);
    expect(lines[0]).not.toContain('WARNING');
    expect(lines[1]).not.toContain('WARNING');
    expect(lines[2]).toBe(
      '[Mem] renderer=3072MB main=99MB gpu=0MB other=0MB total=3171MB rendererCpu=96.0% WARNING renderer grew 24x since startup (128MB)',
    );
  });

  it('swallows metric errors', () => {
    expect(() => sampleMemory(() => { throw new Error('boom'); }, () => {})).not.toThrow();
  });
});
