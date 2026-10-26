// Décodeur de plage LZMA, portage de xz_dec_lzma2.c (section « Range decoder ») d'XZ Embedded :
// Copyright (C) The XZ Embedded authors and contributors (Lasse Collin, Igor Pavlov), licence 0BSD
// (ADR-0015). Différence : il lit un morceau LZMA2 complet déjà en mémoire et toute lecture
// au-delà de ce morceau est une donnée corrompue (le C lit un tampon complété par des zéros).

import { at16 } from '../bytes.js';
import { FormatError } from '../errors.js';

const TOP_VALUE = 1 << 24;
const BIT_MODEL_TOTAL_BITS = 11;
const BIT_MODEL_TOTAL = 1 << BIT_MODEL_TOTAL_BITS;
const MOVE_BITS = 5;
/** Octets d'initialisation en tête de chaque morceau LZMA. */
export const RC_INIT_BYTES = 5;
/** Valeur initiale de toute probabilité. */
export const PROBABILITY_INIT = BIT_MODEL_TOTAL / 2;

export class RangeDecoder {
  #range = 0;
  #code = 0;
  #input: Uint8Array = new Uint8Array(0);
  #position = 0;

  /** Démarre un morceau : lit les cinq octets d'initialisation (le premier est ignoré). */
  init(input: Uint8Array): void {
    this.#input = input;
    this.#position = 0;
    this.#range = 0xffffffff;
    this.#code = 0;
    for (let index = 0; index < RC_INIT_BYTES; index += 1) this.#code = ((this.#code << 8) | this.#next()) >>> 0;
  }

  /** Vrai si tout le morceau a été lu et que le codeur est dans son état final. */
  finished(): boolean {
    return this.#position === this.#input.length && this.#code === 0;
  }

  normalize(): void {
    if (this.#range < TOP_VALUE) {
      this.#range = (this.#range << 8) >>> 0;
      this.#code = ((this.#code << 8) | this.#next()) >>> 0;
    }
  }

  bit(probabilities: Uint16Array, index: number): number {
    this.normalize();
    const probability = at16(probabilities, index);
    const bound = (this.#range >>> BIT_MODEL_TOTAL_BITS) * probability;
    if (this.#code < bound) {
      this.#range = bound;
      probabilities[index] = probability + ((BIT_MODEL_TOTAL - probability) >>> MOVE_BITS);
      return 0;
    }
    this.#range -= bound;
    this.#code -= bound;
    probabilities[index] = probability - (probability >>> MOVE_BITS);
    return 1;
  }

  /** Arbre de bits, bit de poids fort d'abord ; rend un symbole dans [limit, 2 x limit). */
  bittree(probabilities: Uint16Array, base: number, limit: number): number {
    let symbol = 1;
    do {
      symbol = (symbol << 1) + this.bit(probabilities, base + symbol);
    } while (symbol < limit);
    return symbol;
  }

  /** Arbre de bits inversé (bit de poids faible d'abord) sur `count` bits ; rend la valeur lue. */
  bittreeReverse(probabilities: Uint16Array, base: number, count: number): number {
    let symbol = 1;
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      const bit = this.bit(probabilities, base + symbol);
      symbol = (symbol << 1) + bit;
      value += bit << index;
    }
    return value;
  }

  /** Bits directs (probabilité fixe 1/2), ajoutés à `value` par décalage : rend la nouvelle valeur. */
  direct(value: number, count: number): number {
    let result = value;
    for (let index = 0; index < count; index += 1) {
      this.normalize();
      this.#range >>>= 1;
      this.#code = (this.#code - this.#range) >>> 0;
      if (this.#code >= 0x80000000) {
        this.#code = (this.#code + this.#range) >>> 0;
        result *= 2;
      } else {
        result = result * 2 + 1;
      }
    }
    return result;
  }

  #next(): number {
    const byte = this.#input[this.#position];
    if (byte === undefined) throw new FormatError('FORMAT_CORRUPT_STREAM', 'flux xz : morceau LZMA trop court');
    this.#position += 1;
    return byte;
  }
}
