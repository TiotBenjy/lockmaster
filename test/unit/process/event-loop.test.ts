import { describe, expect, it } from 'vitest';
import { EventLoopMonitor } from '../../../src/process/event-loop.js';

/** Histogramme factice : p99 en nanosecondes, comme perf_hooks. */
function histogram(p99Ms: number) {
  return { percentile: (_p: number) => p99Ms * 1e6, reset: () => {}, enable: () => {}, disable: () => {} };
}

describe('EventLoopMonitor', () => {
  it('est sain sous le seuil et malade au-dessus', () => {
    expect(new EventLoopMonitor({ thresholdMs: 500 }, histogram(20)).healthy()).toBe(true);
    expect(new EventLoopMonitor({ thresholdMs: 500 }, histogram(800)).healthy()).toBe(false);
  });

  it('expose le p99 en millisecondes pour /metrics', () => {
    expect(new EventLoopMonitor({ thresholdMs: 500 }, histogram(42)).p99Ms()).toBe(42);
  });

  it("fonctionne avec le vrai histogramme de Node et s'arrête proprement", () => {
    const monitor = new EventLoopMonitor({ thresholdMs: 10_000 });
    monitor.start();
    expect(monitor.healthy()).toBe(true);
    monitor.stop();
  });
});
