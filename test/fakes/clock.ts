import type { Clock } from '../../src/domain/ports.js';

/** Horloge de test : instant fixe, avancé explicitement par le test (jamais de `sleep`). */
export class FakeClock implements Clock {
  #epochMs: number;

  constructor(start: Date) {
    this.#epochMs = start.getTime();
  }

  now(): Date {
    return new Date(this.#epochMs);
  }

  advance(ms: number): void {
    this.#epochMs += ms;
  }
}
