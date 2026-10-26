// CRC64 du format .xz (ECMA-182, polynôme réfléchi 0xC96C5795D7870F42 ; xz-file-format.txt §3.4).
// Calcul par table sur deux moitiés de 32 bits (pas de BigInt dans la boucle chaude).
// Portage de xz_crc64.c d'XZ Embedded : Copyright (C) The XZ Embedded authors and contributors,
// licence 0BSD (ADR-0015).

import { at, at32 } from '../bytes.js';

const POLY_HIGH = 0xc96c5795;
const POLY_LOW = 0xd7870f42;

const TABLE_HIGH = new Uint32Array(256);
const TABLE_LOW = new Uint32Array(256);

for (let index = 0; index < 256; index += 1) {
  let high = 0;
  let low = index;
  for (let bit = 0; bit < 8; bit += 1) {
    const carry = low & 1;
    low = ((low >>> 1) | ((high & 1) << 31)) >>> 0;
    high >>>= 1;
    if (carry !== 0) {
      high = (high ^ POLY_HIGH) >>> 0;
      low = (low ^ POLY_LOW) >>> 0;
    }
  }
  TABLE_HIGH[index] = high;
  TABLE_LOW[index] = low;
}

/** État d'un CRC64 en cours : [moitié haute, moitié basse], valeur finale (non complémentée). */
export class Crc64 {
  #high = 0xffffffff;
  #low = 0xffffffff;

  update(bytes: Uint8Array): void {
    let high = this.#high;
    let low = this.#low;
    for (let index = 0; index < bytes.length; index += 1) {
      const slot = (low ^ at(bytes, index)) & 0xff;
      low = (at32(TABLE_LOW, slot) ^ ((low >>> 8) | (high << 24))) >>> 0;
      high = (at32(TABLE_HIGH, slot) ^ (high >>> 8)) >>> 0;
    }
    this.#high = high;
    this.#low = low;
  }

  /** Valeur sur 8 octets, petit-boutiste, telle qu'écrite dans le champ Check. */
  digest(): Uint8Array {
    const result = new Uint8Array(8);
    const view = new DataView(result.buffer);
    view.setUint32(0, ~this.#low >>> 0, true);
    view.setUint32(4, ~this.#high >>> 0, true);
    return result;
  }
}
