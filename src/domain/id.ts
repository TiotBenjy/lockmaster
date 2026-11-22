import { LockmasterError } from './errors.js';
import type { Clock, RandomSource } from './ports.js';

// Identifiants ULID (docs/05) : 48 bits de millisecondes puis 80 bits d'aléa, en base 32 de Crockford
// (26 caractères), triables par date de création. Écrit ici plutôt que par le paquet `ulid` : une
// trentaine de lignes, et l'horloge comme l'aléa restent injectés (tests déterministes).
// Monotone dans un même générateur : même milliseconde ou horloge qui recule -> aléa précédent + 1.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const MAX_TIME = 2 ** 48 - 1;
const ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export type IdGenerator = () => string;

function encodeTime(ms: number): string {
  let out = '';
  for (let value = ms, i = 0; i < TIME_CHARS; i++, value = Math.floor(value / 32)) {
    out = ALPHABET.charAt(value % 32) + out;
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): number[] {
  // 80 bits -> 16 chiffres de 5 bits.
  const digits: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      digits.push((buffer >> bits) & 31);
    }
    buffer &= (1 << bits) - 1;
  }
  return digits;
}

function increment(digits: number[]): number[] {
  const next = [...digits];
  for (let i = next.length - 1; i >= 0; i--) {
    const digit = next[i] ?? 0;
    if (digit < 31) {
      next[i] = digit + 1;
      return next;
    }
    next[i] = 0;
  }
  throw new LockmasterError('ID_EXHAUSTED', 'plus aucun identifiant disponible dans cette milliseconde');
}

export function createIdGenerator(clock: Clock, random: RandomSource): IdGenerator {
  let lastTime = -1;
  let lastRandom: number[] = [];
  return () => {
    const now = clock.now().getTime();
    if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) {
      throw new LockmasterError('ID_CLOCK_INVALID', 'horloge hors de la plage des identifiants');
    }
    if (now > lastTime) {
      lastTime = now;
      lastRandom = encodeRandom(random.bytes(10));
    } else {
      lastRandom = increment(lastRandom);
    }
    return encodeTime(lastTime) + lastRandom.map((digit) => ALPHABET.charAt(digit)).join('');
  };
}

export function isId(value: string): boolean {
  return ID_PATTERN.test(value) && value.length === TIME_CHARS + RANDOM_CHARS;
}
