import type { EventEmitter } from 'node:events';
import type { Logger } from '../log.js';

// Conception « crash-only » (docs/01 §4) :
//  - exception ou rejet non géré : journalisation puis arrêt immédiat (code 70), jamais de poursuite
//    dans un état inconnu ; systemd ou le moteur de conteneurs relance, la reprise des jobs rétablit ;
//  - SIGTERM / SIGINT : arrêt propre (plus de requêtes, jobs annulés, base fermée) dans un délai borné,
//    sinon code 1.

export const EXIT_SOFTWARE = 70;

export interface ProcessHandlersOptions {
  process: EventEmitter;
  exit: (code: number) => void;
  logger: Logger;
  onShutdown: () => Promise<void>;
  shutdownTimeoutMs: number;
}

export function installProcessHandlers(options: ProcessHandlersOptions): void {
  const { process: proc, exit, logger } = options;
  let stopping = false;

  const crash = (kind: string) => (error: unknown) => {
    logger.fatal({ event: 'process.uncaught', kind, err: error }, 'unhandled error, exiting now');
    exit(EXIT_SOFTWARE);
  };
  proc.on('uncaughtException', crash('exception'));
  proc.on('unhandledRejection', crash('rejection'));

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ event: 'process.shutdown', signal }, 'shutdown requested');
    const timer = setTimeout(() => {
      logger.error({ event: 'process.shutdown_timeout', signal }, 'shutdown timed out');
      exit(1);
    }, options.shutdownTimeoutMs);
    timer.unref?.();
    options.onShutdown().then(
      () => {
        clearTimeout(timer);
        exit(0);
      },
      (error: unknown) => {
        clearTimeout(timer);
        logger.error({ event: 'process.shutdown_failed', err: error }, 'graceful shutdown failed');
        exit(1);
      },
    );
  };
  proc.on('SIGTERM', () => shutdown('SIGTERM'));
  proc.on('SIGINT', () => shutdown('SIGINT'));
}
