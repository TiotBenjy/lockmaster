import { describe, expect, it } from 'vitest';
import { expectSameBytes } from '../../helpers/bytes.js';

describe('expectSameBytes', () => {
  const data = Uint8Array.from({ length: 1000 }, (_, index) => index % 256);

  it('accepte deux contenus identiques, y compris des vues décalées', () => {
    const shifted = new Uint8Array(1010);
    shifted.set(data, 10);
    expectSameBytes(shifted.subarray(10), data);
  });

  it('échoue sur une longueur différente ou un seul octet différent', () => {
    expect(() => expectSameBytes(data.subarray(1), data)).toThrow(/longueur/);
    const altered = data.slice();
    altered[777] = (altered[777] ?? 0) ^ 1;
    expect(() => expectSameBytes(altered, data)).toThrow(/position 777/);
  });
});
