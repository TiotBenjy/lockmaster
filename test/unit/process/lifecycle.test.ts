import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../../src/log.js';
import { installProcessHandlers } from '../../../src/process/lifecycle.js';
import { LogCapture } from '../../helpers/deps.js';

function setup(onShutdown: () => Promise<void>, shutdownTimeoutMs = 1000) {
  const proc = new EventEmitter();
  const exit = vi.fn<(code: number) => void>();
  const logs = new LogCapture();
  const logger = createLogger({ level: 'info', format: 'json' }, logs);
  installProcessHandlers({ process: proc, exit, logger, onShutdown, shutdownTimeoutMs });
  return { proc, exit, logs };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('installProcessHandlers (docs/01 §4, crash-only)', () => {
  it('journalise puis quitte en code 70 sur exception non gérée, sans arrêt propre', async () => {
    const onShutdown = vi.fn(async () => {});
    const { proc, exit, logs } = setup(onShutdown);
    proc.emit('uncaughtException', new Error('boum'));
    await flush();
    expect(exit).toHaveBeenCalledWith(70);
    expect(onShutdown).not.toHaveBeenCalled();
    expect(logs.lines[0]).toMatchObject({ level: 'fatal', event: 'process.uncaught' });
  });

  it('fait de même sur promesse rejetée non gérée', async () => {
    const { proc, exit } = setup(async () => {});
    proc.emit('unhandledRejection', new Error('rejet'));
    await flush();
    expect(exit).toHaveBeenCalledWith(70);
  });

  it.each(['SIGTERM', 'SIGINT'])('sur %s : arrêt propre puis code 0', async (signal) => {
    const onShutdown = vi.fn(async () => {});
    const { proc, exit } = setup(onShutdown);
    proc.emit(signal);
    await flush();
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("un second signal pendant l'arrêt ne relance pas l'arrêt", async () => {
    const onShutdown = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    const { proc, exit } = setup(onShutdown);
    proc.emit('SIGTERM');
    proc.emit('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("quitte en code 1 si l'arrêt propre échoue ou dépasse le délai", async () => {
    const failing = setup(async () => {
      throw new Error('fermeture impossible');
    });
    failing.proc.emit('SIGTERM');
    await flush();
    expect(failing.exit).toHaveBeenCalledWith(1);

    vi.useFakeTimers();
    try {
      const hanging = setup(() => new Promise<void>(() => {}), 500);
      hanging.proc.emit('SIGTERM');
      await vi.advanceTimersByTimeAsync(600);
      expect(hanging.exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
