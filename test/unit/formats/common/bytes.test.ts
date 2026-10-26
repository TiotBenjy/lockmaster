import { describe, expect, it } from 'vitest';
import { at, at16, at32, atInt32, atNumber } from '../../../../src/formats/common/bytes.js';

describe('accesseurs vérifiés', () => {
  const cases = [
    ['at', (index: number) => at(Uint8Array.of(7, 8, 9), index)],
    ['at16', (index: number) => at16(Uint16Array.of(7, 8, 9), index)],
    ['at32', (index: number) => at32(Uint32Array.of(7, 8, 9), index)],
    ['atInt32', (index: number) => atInt32(Int32Array.of(7, 8, 9), index)],
    ['atNumber', (index: number) => atNumber([7, 8, 9], index)],
  ] as const;

  it.each(cases)('%s rend la valeur à un indice valide', (_name, read) => {
    expect(read(0)).toBe(7);
    expect(read(2)).toBe(9);
  });

  it.each(cases)('%s lève FORMAT_INVALID hors limites', (_name, read) => {
    for (const index of [-1, 3, 1.5, Number.NaN]) {
      expect(() => read(index)).toThrowError(expect.objectContaining({ code: 'FORMAT_INVALID' }));
    }
  });
});
