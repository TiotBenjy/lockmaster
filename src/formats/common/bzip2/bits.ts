// Lecture de bits (poids fort d'abord) et tables de Huffman canoniques du format bzip2 (ADR-0015).
// Écrit d'après le format : codes canoniques attribués par longueur croissante puis par symbole
// croissant, longueurs de 1 à 20 bits.

import { at16, atInt32 } from '../bytes.js';
import { FormatError } from '../errors.js';

export const corrupt = (reason: string): FormatError =>
  new FormatError('FORMAT_CORRUPT_STREAM', `flux bzip2 : ${reason}`);

/** Lecteur de bits sur une fenêtre en mémoire ; dépasser la fenêtre est une donnée corrompue. */
export class BitReader {
  readonly #bytes: Uint8Array;
  #position: number;

  constructor(bytes: Uint8Array, bitOffset: number) {
    this.#bytes = bytes;
    this.#position = bitOffset;
  }

  /** Position courante, en bits depuis le début de la fenêtre. */
  get position(): number {
    return this.#position;
  }

  bit(): number {
    const byte = this.#bytes[this.#position >>> 3];
    if (byte === undefined) throw corrupt('flux tronqué ou bloc trop long');
    const bit = (byte >>> (7 - (this.#position & 7))) & 1;
    this.#position += 1;
    return bit;
  }

  /** Lit `count` bits (au plus 24). */
  bits(count: number): number {
    let value = 0;
    for (let index = 0; index < count; index += 1) value = (value << 1) | this.bit();
    return value;
  }
}

export const MAX_CODE_LENGTH = 20;

export class HuffmanTable {
  readonly #minLength: number;
  readonly #maxLength: number;
  readonly #count = new Int32Array(MAX_CODE_LENGTH + 2);
  readonly #firstCode = new Int32Array(MAX_CODE_LENGTH + 2);
  readonly #firstIndex = new Int32Array(MAX_CODE_LENGTH + 2);
  readonly #symbols: Uint16Array;

  /** `lengths[symbole]` : longueur du code (1 à 20). */
  constructor(lengths: Uint8Array) {
    this.#minLength = Math.min(...lengths);
    this.#maxLength = Math.max(...lengths);
    this.#symbols = new Uint16Array(lengths.length);
    let index = 0;
    let code = 0;
    for (let length = this.#minLength; length <= this.#maxLength; length += 1) {
      this.#firstCode[length] = code;
      this.#firstIndex[length] = index;
      for (let symbol = 0; symbol < lengths.length; symbol += 1) {
        if (lengths[symbol] === length) {
          this.#symbols[index] = symbol;
          index += 1;
        }
      }
      this.#count[length] = index - atInt32(this.#firstIndex, length);
      code = (code + atInt32(this.#count, length)) * 2;
    }
  }

  decode(reader: BitReader): number {
    let length = this.#minLength;
    let value = reader.bits(length);
    for (;;) {
      const offset = value - atInt32(this.#firstCode, length);
      if (offset >= 0 && offset < atInt32(this.#count, length)) {
        return at16(this.#symbols, atInt32(this.#firstIndex, length) + offset);
      }
      length += 1;
      if (length > this.#maxLength) throw corrupt('code de Huffman invalide');
      value = (value << 1) | reader.bit();
    }
  }
}
