// Dictionnaire (historique circulaire) du décodeur LZMA2, portage de xz_dec_lzma2.c (section
// « Dictionary », mode multi-appel) d'XZ Embedded : Copyright (C) The XZ Embedded authors and
// contributors, licence 0BSD (ADR-0015). Différence : la capacité allouée peut être plus petite que
// la taille déclarée par le flux (borne mémoire) ; une distance au-delà de ce qui est conservé est
// alors une limite atteinte, jamais une lecture hors du tampon.

import { at } from '../bytes.js';
import { FormatError } from '../errors.js';

export class Dictionary {
  #buffer: Uint8Array = new Uint8Array(0);
  /** Début des octets décodés pas encore rendus. */
  #start = 0;
  #pos = 0;
  /** Nombre d'octets valides dans le tampon (sert à refuser une distance avant le début). */
  #full = 0;
  #limit = 0;
  /** Capacité utilisée (fin du tampon circulaire). */
  #end = 0;
  /** Taille déclarée par l'en-tête de bloc. */
  #size = 0;

  /** Prépare un bloc : réutilise le tampon s'il est assez grand. */
  configure(declaredSize: number, capacity: number): void {
    if (this.#buffer.length < capacity) this.#buffer = new Uint8Array(capacity);
    this.#end = capacity;
    this.#size = declaredSize;
    this.reset();
  }

  reset(): void {
    this.#start = 0;
    this.#pos = 0;
    this.#limit = 0;
    this.#full = 0;
  }

  get pos(): number {
    return this.#pos;
  }

  /** Autorise au plus `outMax` octets avant le prochain `flush`. */
  setLimit(outMax: number): void {
    this.#limit = this.#end - this.#pos <= outMax ? this.#end : this.#pos + outMax;
  }

  hasSpace(): boolean {
    return this.#pos < this.#limit;
  }

  /** Octet à la distance `dist` (0 = dernier octet écrit) ; 0 si le dictionnaire est vide. */
  get(dist: number): number {
    let offset = this.#pos - dist - 1;
    if (dist >= this.#pos) offset += this.#end;
    return this.#full > 0 ? at(this.#buffer, offset) : 0;
  }

  put(byte: number): void {
    this.#buffer[this.#pos] = byte;
    this.#pos += 1;
    if (this.#full < this.#pos) this.#full = this.#pos;
  }

  /** Recopie jusqu'à `length` octets depuis la distance `dist` ; rend la longueur restant à copier. */
  repeat(length: number, dist: number): number {
    if (dist >= this.#full || dist >= this.#size) {
      if (dist < this.#size && this.#full === this.#end) {
        throw new FormatError('FORMAT_LIMIT_EXCEEDED', 'flux xz : distance au-delà du dictionnaire autorisé');
      }
      throw new FormatError('FORMAT_CORRUPT_STREAM', 'flux xz : distance de correspondance invalide');
    }
    let left = Math.min(this.#limit - this.#pos, length);
    const remaining = length - left;
    let back = this.#pos - dist - 1;
    if (dist >= this.#pos) back += this.#end;
    while (left > 0) {
      this.#buffer[this.#pos] = at(this.#buffer, back);
      this.#pos += 1;
      back += 1;
      if (back === this.#end) back = 0;
      left -= 1;
    }
    if (this.#full < this.#pos) this.#full = this.#pos;
    return remaining;
  }

  /** Copie les octets décodés depuis le dernier appel dans `out` à `outPos` ; rend leur nombre. */
  flush(out: Uint8Array, outPos: number): number {
    const count = this.#pos - this.#start;
    if (this.#pos === this.#end) this.#pos = 0;
    out.set(this.#buffer.subarray(this.#start, this.#start + count), outPos);
    this.#start = this.#pos;
    return count;
  }

  /** Morceau non compressé : copié tel quel dans le dictionnaire, rendu tel quel. */
  uncompressed(input: Uint8Array): Uint8Array {
    let offset = 0;
    while (offset < input.length) {
      const count = Math.min(input.length - offset, this.#end - this.#pos);
      this.#buffer.set(input.subarray(offset, offset + count), this.#pos);
      this.#pos += count;
      if (this.#full < this.#pos) this.#full = this.#pos;
      if (this.#pos === this.#end) this.#pos = 0;
      offset += count;
    }
    this.#start = this.#pos;
    return input;
  }
}
