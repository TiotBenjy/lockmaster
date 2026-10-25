import { createHash } from 'node:crypto';
import type { RandomSource } from '../../src/domain/ports.js';

/** Aléa de test déterministe : SHA-256(graine || compteur), reproductible d'une exécution à l'autre. */
export class FakeRandom implements RandomSource {
  readonly #seed: string;
  #counter = 0;

  constructor(seed: string) {
    this.#seed = seed;
  }

  bytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += 32) {
      const block = createHash('sha256')
        .update(`${this.#seed}:${this.#counter++}`)
        .digest();
      out.set(block.subarray(0, Math.min(32, length - offset)), offset);
    }
    return out;
  }
}
