// Décodeur LZMA2, portage de xz_dec_lzma2.c et xz_lzma2.h d'XZ Embedded : Copyright (C) The XZ
// Embedded authors and contributors (Lasse Collin, Igor Pavlov), licence 0BSD (ADR-0015).
// Différence de structure : chaque morceau LZMA2 (au plus 64 Kio compressés, 2 Mio décompressés)
// est lu en entier, puis décodé d'un seul tenant ; la sortie de chaque morceau est réservée auprès
// du budget avant d'être produite.

import { at } from '../bytes.js';
import { FormatError } from '../errors.js';
import type { StreamReader } from '../stream-reader.js';
import type { Dictionary } from './dictionary.js';
import { PROBABILITY_INIT, RangeDecoder, RC_INIT_BYTES } from './range-decoder.js';

const POS_STATES_MAX = 16;
const LIT_STATES = 7;
const LITERAL_CODER_SIZE = 0x300;
const MATCH_LEN_MIN = 2;
const LEN_LOW_SYMBOLS = 8;
const LEN_MID_SYMBOLS = 8;
const LEN_HIGH_SYMBOLS = 256;
const DIST_STATES = 4;
const DIST_SLOTS = 64;
const DIST_MODEL_START = 4;
const DIST_MODEL_END = 14;
const ALIGN_BITS = 4;

// Probabilités d'un décodeur de longueur : choice, choice2, low[16][8], mid[16][8], high[256].
const LEN_CHOICE = 0;
const LEN_CHOICE2 = 1;
const LEN_LOW = 2;
const LEN_MID = LEN_LOW + POS_STATES_MAX * LEN_LOW_SYMBOLS;
const LEN_HIGH = LEN_MID + POS_STATES_MAX * LEN_MID_SYMBOLS;
const LEN_SIZE = LEN_HIGH + LEN_HIGH_SYMBOLS;

// Toutes les probabilités dans un seul tableau, dans l'ordre de `struct lzma_dec` (1846 + littéraux).
const IS_MATCH = 0;
const IS_REP = IS_MATCH + 12 * POS_STATES_MAX;
const IS_REP0 = IS_REP + 12;
const IS_REP1 = IS_REP0 + 12;
const IS_REP2 = IS_REP1 + 12;
const IS_REP0_LONG = IS_REP2 + 12;
const DIST_SLOT = IS_REP0_LONG + 12 * POS_STATES_MAX;
const DIST_SPECIAL = DIST_SLOT + DIST_STATES * DIST_SLOTS;
const DIST_ALIGN = DIST_SPECIAL + (128 - DIST_MODEL_END);
const MATCH_LEN = DIST_ALIGN + (1 << ALIGN_BITS);
const REP_LEN = MATCH_LEN + LEN_SIZE;
const LITERAL = REP_LEN + LEN_SIZE;
const PROBS_TOTAL = LITERAL + 16 * LITERAL_CODER_SIZE;

/** Réserve `bytes` octets de sortie auprès du budget (lève FORMAT_LIMIT_EXCEEDED au-delà). */
export type ReserveOutput = (bytes: number) => void;

const corrupt = (reason: string): FormatError => new FormatError('FORMAT_CORRUPT_STREAM', `flux xz : ${reason}`);

export class Lzma2Decoder {
  readonly #dict: Dictionary;
  readonly #rc = new RangeDecoder();
  readonly #probs = new Uint16Array(PROBS_TOTAL);
  #state = 0;
  #rep0 = 0;
  #rep1 = 0;
  #rep2 = 0;
  #rep3 = 0;
  #len = 0;
  #lc = 0;
  #literalPosMask = 0;
  #posMask = 0;

  constructor(dictionary: Dictionary) {
    this.#dict = dictionary;
  }

  /** Décode un flux LZMA2 complet (jusqu'au marqueur de fin 0x00) ; rend la sortie par morceau. */
  async *run(reader: StreamReader, reserve: ReserveOutput): AsyncGenerator<Uint8Array> {
    let needDictReset = true;
    let needProps = true;
    for (;;) {
      const control = await reader.readByte();
      if (control === 0x00) return;
      if (control >= 0xe0 || control === 0x01) {
        needProps = true;
        needDictReset = false;
        this.#dict.reset();
      } else if (needDictReset) {
        throw corrupt('le premier morceau ne réinitialise pas le dictionnaire');
      }
      if (control < 0x80) {
        if (control > 0x02) throw corrupt('octet de contrôle LZMA2 invalide');
        const header = await reader.readExact(2);
        const size = (at(header, 0) << 8) + at(header, 1) + 1;
        reserve(size);
        yield this.#dict.uncompressed(await reader.readExact(size));
        continue;
      }
      const header = await reader.readExact(control >= 0xc0 ? 5 : 4);
      const uncompressed = ((control & 0x1f) << 16) + (at(header, 0) << 8) + at(header, 1) + 1;
      const compressed = (at(header, 2) << 8) + at(header, 3) + 1;
      if (control >= 0xc0) {
        this.#setProperties(at(header, 4));
        needProps = false;
      } else if (needProps) {
        throw corrupt('morceau LZMA sans propriétés');
      } else if (control >= 0xa0) {
        this.#resetState();
      }
      if (compressed < RC_INIT_BYTES) throw corrupt('morceau LZMA trop court');
      reserve(uncompressed);
      yield this.#decodeChunk(await reader.readExact(compressed), uncompressed);
    }
  }

  #decodeChunk(input: Uint8Array, uncompressed: number): Uint8Array {
    this.#rc.init(input);
    const out = new Uint8Array(uncompressed);
    let produced = 0;
    while (produced < uncompressed) {
      this.#dict.setLimit(uncompressed - produced);
      this.#decodeSymbols();
      produced += this.#dict.flush(out, produced);
    }
    if (this.#len > 0 || !this.#rc.finished()) throw corrupt('fin de morceau LZMA incohérente');
    return out;
  }

  /** `lzma_main` : décode des symboles tant que le dictionnaire a de la place. */
  #decodeSymbols(): void {
    const dict = this.#dict;
    const rc = this.#rc;
    const probs = this.#probs;
    if (dict.hasSpace() && this.#len > 0) this.#len = dict.repeat(this.#len, this.#rep0);
    while (dict.hasSpace()) {
      const posState = dict.pos & this.#posMask;
      if (rc.bit(probs, IS_MATCH + this.#state * POS_STATES_MAX + posState) === 0) {
        this.#literal();
        continue;
      }
      if (rc.bit(probs, IS_REP + this.#state) === 1) this.#repMatch(posState);
      else this.#match(posState);
      this.#len = dict.repeat(this.#len, this.#rep0);
    }
    rc.normalize();
  }

  #literal(): void {
    const dict = this.#dict;
    const rc = this.#rc;
    const probs = this.#probs;
    const prevByte = dict.get(0);
    const base =
      LITERAL + ((prevByte >> (8 - this.#lc)) + ((dict.pos & this.#literalPosMask) << this.#lc)) * LITERAL_CODER_SIZE;
    let symbol: number;
    if (this.#state < LIT_STATES) {
      symbol = rc.bittree(probs, base, 0x100);
    } else {
      symbol = 1;
      let matchByte = dict.get(this.#rep0) << 1;
      let offset = 0x100;
      do {
        const matchBit = matchByte & offset;
        matchByte <<= 1;
        if (rc.bit(probs, base + offset + matchBit + symbol) === 1) {
          symbol = (symbol << 1) + 1;
          offset &= matchBit;
        } else {
          symbol <<= 1;
          offset &= ~matchBit;
        }
      } while (symbol < 0x100);
    }
    dict.put(symbol & 0xff);
    if (this.#state <= 3) this.#state = 0;
    else if (this.#state <= 9) this.#state -= 3;
    else this.#state -= 6;
  }

  /** Longueur de correspondance dans `#len` (2 à 273). */
  #decodeLength(base: number, posState: number): void {
    const rc = this.#rc;
    const probs = this.#probs;
    let tree: number;
    let limit: number;
    if (rc.bit(probs, base + LEN_CHOICE) === 0) {
      tree = base + LEN_LOW + posState * LEN_LOW_SYMBOLS;
      limit = LEN_LOW_SYMBOLS;
      this.#len = MATCH_LEN_MIN;
    } else if (rc.bit(probs, base + LEN_CHOICE2) === 0) {
      tree = base + LEN_MID + posState * LEN_MID_SYMBOLS;
      limit = LEN_MID_SYMBOLS;
      this.#len = MATCH_LEN_MIN + LEN_LOW_SYMBOLS;
    } else {
      tree = base + LEN_HIGH;
      limit = LEN_HIGH_SYMBOLS;
      this.#len = MATCH_LEN_MIN + LEN_LOW_SYMBOLS + LEN_MID_SYMBOLS;
    }
    this.#len += this.#rc.bittree(probs, tree, limit) - limit;
  }

  #match(posState: number): void {
    const rc = this.#rc;
    const probs = this.#probs;
    this.#state = this.#state < LIT_STATES ? 7 : 10;
    this.#rep3 = this.#rep2;
    this.#rep2 = this.#rep1;
    this.#rep1 = this.#rep0;
    this.#decodeLength(MATCH_LEN, posState);
    const distState = this.#len < DIST_STATES + MATCH_LEN_MIN ? this.#len - MATCH_LEN_MIN : DIST_STATES - 1;
    const slot = rc.bittree(probs, DIST_SLOT + distState * DIST_SLOTS, DIST_SLOTS) - DIST_SLOTS;
    if (slot < DIST_MODEL_START) {
      this.#rep0 = slot;
      return;
    }
    const limit = (slot >>> 1) - 1;
    const high = 2 + (slot & 1);
    if (slot < DIST_MODEL_END) {
      const shifted = high << limit;
      this.#rep0 = shifted + rc.bittreeReverse(probs, DIST_SPECIAL + shifted - slot - 1, limit);
    } else {
      const withDirect = rc.direct(high, limit - ALIGN_BITS);
      this.#rep0 = withDirect * (1 << ALIGN_BITS) + rc.bittreeReverse(probs, DIST_ALIGN, ALIGN_BITS);
    }
  }

  #repMatch(posState: number): void {
    const rc = this.#rc;
    const probs = this.#probs;
    if (rc.bit(probs, IS_REP0 + this.#state) === 0) {
      if (rc.bit(probs, IS_REP0_LONG + this.#state * POS_STATES_MAX + posState) === 0) {
        this.#state = this.#state < LIT_STATES ? 9 : 11;
        this.#len = 1;
        return;
      }
    } else {
      let distance: number;
      if (rc.bit(probs, IS_REP1 + this.#state) === 0) {
        distance = this.#rep1;
      } else {
        if (rc.bit(probs, IS_REP2 + this.#state) === 0) {
          distance = this.#rep2;
        } else {
          distance = this.#rep3;
          this.#rep3 = this.#rep2;
        }
        this.#rep2 = this.#rep1;
      }
      this.#rep1 = this.#rep0;
      this.#rep0 = distance;
    }
    this.#state = this.#state < LIT_STATES ? 8 : 11;
    this.#decodeLength(REP_LEN, posState);
  }

  /** `lzma_props` : lc/lp/pb codés en un octet, lc + lp <= 4 ; réinitialise l'état. */
  #setProperties(props: number): void {
    if (props > (4 * 5 + 4) * 9 + 8) throw corrupt('propriétés LZMA invalides');
    const pb = Math.floor(props / 45);
    const lp = Math.floor((props % 45) / 9);
    const lc = props % 9;
    if (lc + lp > 4) throw corrupt('propriétés LZMA invalides');
    this.#posMask = (1 << pb) - 1;
    this.#literalPosMask = (1 << lp) - 1;
    this.#lc = lc;
    this.#resetState();
  }

  #resetState(): void {
    this.#state = 0;
    this.#rep0 = 0;
    this.#rep1 = 0;
    this.#rep2 = 0;
    this.#rep3 = 0;
    this.#len = 0;
    this.#probs.fill(PROBABILITY_INIT);
  }
}
