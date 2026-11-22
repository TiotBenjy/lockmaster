import { expect } from 'vitest';

// Égalité exacte de deux tableaux d'octets. `toEqual` compare élément par élément et prend environ une
// seconde pour 200 000 octets (des dépassements de délai sous charge) ; Buffer.equals compare en natif.
// En cas d'écart, l'assertion désigne la longueur ou le premier octet différent.

export function expectSameBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length, 'longueur').toBe(expected.length);
  const a = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength);
  const b = Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength);
  if (a.equals(b)) return;
  const offset = a.findIndex((byte, index) => byte !== b[index]);
  expect(a[offset], `octet à la position ${offset}`).toBe(b[offset]);
}
