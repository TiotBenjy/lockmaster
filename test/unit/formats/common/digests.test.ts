import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeDigests, DigestAccumulator } from '../../../../src/formats/common/digests.js';
import { BufferSource } from '../../../../src/formats/common/source.js';

const DATA = Uint8Array.from({ length: 100_000 }, (_, index) => (index * 31 + 7) % 256);
const hex = (algorithm: string, data: Uint8Array) => createHash(algorithm).update(data).digest('hex');

describe('DigestAccumulator', () => {
  it('rend les quatre empreintes et la taille, quel que soit le découpage', () => {
    const expected = {
      sha256: hex('sha256', DATA),
      sha512: hex('sha512', DATA),
      sha1: hex('sha1', DATA),
      md5: hex('md5', DATA),
    };
    for (const step of [1_000, 4_096, 100_000]) {
      const accumulator = new DigestAccumulator();
      for (let offset = 0; offset < DATA.length; offset += step)
        accumulator.update(DATA.subarray(offset, offset + step));
      expect(accumulator.size).toBe(DATA.length);
      expect(accumulator.finish()).toEqual(expected);
    }
  });

  it('donne le même résultat que computeDigests sur une source', async () => {
    const accumulator = new DigestAccumulator();
    accumulator.update(DATA);
    expect(accumulator.finish()).toEqual(await computeDigests(new BufferSource(DATA)));
  });
});
