// Periodic one-line memory sample per process group, so a runaway renderer
// leaves a trail in main.log. Metrics source is injected to keep this testable.

const SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_SAMPLE_DELAY_MS = 30 * 1000;
const WARN_MIN_RENDERER_MB = 800;
const WARN_GROWTH_FACTOR = 3;

export interface ProcessMetricLike {
  type: string;
  memory: { workingSetSize: number }; // KB
  cpu: { percentCPUUsage: number };
}

type MetricsSource = () => ProcessMetricLike[];
type LogFn = (message: string) => void;

let firstRendererMb: number | null = null;
let firstTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;

export function sampleMemory(getMetrics: MetricsSource, log: LogFn): void {
  try {
    const kb = { renderer: 0, main: 0, gpu: 0, other: 0 };
    let rendererCpu = 0;
    for (const metric of getMetrics()) {
      const group =
        metric.type === 'Tab' ? 'renderer'
        : metric.type === 'Browser' ? 'main'
        : metric.type === 'GPU' ? 'gpu'
        : 'other';
      kb[group] += metric.memory.workingSetSize;
      if (group === 'renderer') rendererCpu += metric.cpu.percentCPUUsage;
    }
    const mb = (value: number) => Math.round(value / 1024);
    const renderer = mb(kb.renderer);
    if (firstRendererMb === null) firstRendererMb = renderer;

    let line =
      `[Mem] renderer=${renderer}MB main=${mb(kb.main)}MB gpu=${mb(kb.gpu)}MB other=${mb(kb.other)}MB` +
      ` total=${mb(kb.renderer + kb.main + kb.gpu + kb.other)}MB rendererCpu=${rendererCpu.toFixed(1)}%`;
    if (renderer > WARN_MIN_RENDERER_MB && renderer >= WARN_GROWTH_FACTOR * firstRendererMb) {
      line += ` WARNING renderer grew ${Math.round(renderer / Math.max(firstRendererMb, 1))}x since startup (${firstRendererMb}MB)`;
    }
    log(line);
  } catch {
    // diagnostics must never break the app
  }
}

export function startMemoryLog(log: LogFn, getMetrics: MetricsSource): void {
  stopMemoryLog();
  firstTimer = setTimeout(() => sampleMemory(getMetrics, log), FIRST_SAMPLE_DELAY_MS);
  intervalTimer = setInterval(() => sampleMemory(getMetrics, log), SAMPLE_INTERVAL_MS);
}

export function stopMemoryLog(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  firstTimer = null;
  intervalTimer = null;
  firstRendererMb = null;
}
