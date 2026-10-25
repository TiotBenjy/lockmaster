import { monitorEventLoopDelay } from 'node:perf_hooks';

// Surveillance de la boucle d'événements (docs/01 §4) : au-delà du seuil, /readyz passe en échec.
// Le p99 est calculé sur une fenêtre glissante remise à zéro périodiquement.

interface DelayHistogram {
  percentile(p: number): number;
  reset(): void;
  enable(): void;
  disable(): void;
}

export interface EventLoopMonitorOptions {
  thresholdMs: number;
  windowMs?: number;
}

export class EventLoopMonitor {
  readonly #histogram: DelayHistogram;
  readonly #thresholdMs: number;
  readonly #windowMs: number;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: EventLoopMonitorOptions, histogram?: DelayHistogram) {
    this.#thresholdMs = options.thresholdMs;
    this.#windowMs = options.windowMs ?? 30_000;
    this.#histogram = histogram ?? monitorEventLoopDelay({ resolution: 20 });
  }

  start(): void {
    this.#histogram.enable();
    this.#timer = setInterval(() => this.#histogram.reset(), this.#windowMs);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#histogram.disable();
  }

  /** p99 du retard de la boucle sur la fenêtre courante, en millisecondes (NaN si aucune mesure). */
  p99Ms(): number {
    return this.#histogram.percentile(99) / 1e6;
  }

  healthy(): boolean {
    const p99 = this.p99Ms();
    return Number.isNaN(p99) || p99 < this.#thresholdMs;
  }
}
