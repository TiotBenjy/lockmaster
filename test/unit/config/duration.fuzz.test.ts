import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseDuration } from '../../../src/config/duration.js';
import { LockmasterError } from '../../../src/domain/errors.js';

const runs = Number(process.env['FC_NUM_RUNS'] ?? 1000);
const FACTORS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

describe('parseDuration (propriétés)', () => {
  it('relit exactement toute durée bien formée', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), fc.constantFrom(...Object.keys(FACTORS)), (n, unit) => {
        expect(parseDuration(`${n}${unit}`)).toBe(n * FACTORS[unit as keyof typeof FACTORS]);
      }),
      { numRuns: runs },
    );
  });

  it("ne lève jamais autre chose qu'une LockmasterError", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (input) => {
        try {
          const ms = parseDuration(input);
          expect(Number.isSafeInteger(ms) && ms >= 0).toBe(true);
        } catch (error) {
          expect(error).toBeInstanceOf(LockmasterError);
        }
      }),
      { numRuns: runs },
    );
  });
});
