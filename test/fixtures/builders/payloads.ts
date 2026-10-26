// Charges déterministes des corpus de compression : le générateur (corpus-generate.ts) et les tests
// les recalculent à l'identique, seuls les flux compressés sont commités.

/** Générateur xorshift32 : suite reproductible, aucune qualité cryptographique requise. */
function pseudoRandom(seed: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0 || 1;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

const WORDS = ['paquet', 'dépôt', 'signature', 'version', 'canal', 'revue', 'flux', 'archive', 'clé', 'index'];

function text(length: number): Uint8Array {
  const random = pseudoRandom(42, length);
  const parts: string[] = [];
  let size = 0;
  for (let index = 0; size < length; index += 1) {
    const word = `${WORDS[(random[index % length] ?? 0) % WORDS.length]}${index % 13 === 0 ? '.\n' : ' '}`;
    parts.push(word);
    size += Buffer.byteLength(word);
  }
  return Buffer.from(parts.join(''), 'utf8').subarray(0, length);
}

function repeated(block: Uint8Array, times: number): Uint8Array {
  const result = new Uint8Array(block.length * times);
  for (let index = 0; index < times; index += 1) result.set(block, index * block.length);
  return result;
}

const MiB = 1024 * 1024;

export const PAYLOADS = {
  empty: () => new Uint8Array(0),
  text: () => text(200 * 1024),
  random: () => pseudoRandom(7, 70 * 1024),
  mixed: () => Buffer.concat([text(100 * 1024), pseudoRandom(9, 20 * 1024), text(80 * 1024)]),
  zeros: () => new Uint8Array(3 * MiB),
  longrange: () => repeated(pseudoRandom(11, 128 * 1024), 3),
  /** Texte, données incompressibles, texte : xz y émet un morceau non compressé puis un 0xA0. */
  interleaved: () => {
    const random = pseudoRandom(7, 70 * 1024);
    const mirrored = Uint8Array.from(random, (_, index) => (random[random.length - 1 - index] ?? 0) ^ 0x5a);
    return Buffer.concat([text(20 * 1024), random, mirrored, text(20 * 1024)]);
  },
} as const;

export type PayloadName = keyof typeof PAYLOADS;
