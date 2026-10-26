import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FormatError } from '../../../../src/formats/common/errors.js';
import { DEFAULT_LIMITS } from '../../../../src/formats/common/limits.js';
import { BufferSource } from '../../../../src/formats/common/source.js';
import { rpmFormat } from '../../../../src/formats/rpm/format.js';
import { parseRpmHeader } from '../../../../src/formats/rpm/header.js';
import { compareRpmEvr, rpmvercmp } from '../../../../src/formats/rpm/version.js';
import { buildRpm, TYPE } from '../../../fixtures/builders/rpm.js';

const runs = Number(process.env['FC_NUM_RUNS'] ?? 300);
const limits = DEFAULT_LIMITS;

const mutated = (valid: Uint8Array) =>
  fc
    .record({
      changes: fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 8 }),
      cut: fc.option(fc.nat(), { nil: undefined }),
    })
    .map(({ changes, cut }) => {
      const copy = Buffer.from(valid);
      for (const [position, value] of changes) copy[position % copy.length] = value;
      return cut === undefined ? copy : copy.subarray(0, cut % (copy.length + 1));
    });

describe('formats/rpm (propriétés)', () => {
  it("parseRpm ne lève qu'une FormatError sur un paquet muté", async () => {
    const rpm = buildRpm({ compression: 'none', tags: [{ tag: 1024, type: TYPE.STRING, value: 'echo post' }] });
    await fc.assert(
      fc.asyncProperty(mutated(rpm), async (bytes) => {
        try {
          const parsed = await rpmFormat.parse(new BufferSource(bytes), { limits });
          expect(parsed.name).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._+-]*$/);
        } catch (error) {
          expect(error).toBeInstanceOf(FormatError);
        }
      }),
      { numRuns: runs },
    );
  });

  it("parseRpmHeader ne lève qu'une FormatError sur des octets arbitraires après la magie", () => {
    const magic = Uint8Array.of(0x8e, 0xad, 0xe8, 0x01, 0, 0, 0, 0);
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 600 }), fc.constantFrom('signature', 'main' as const), (tail, kind) => {
        try {
          parseRpmHeader(Buffer.concat([magic, tail]), kind as 'signature' | 'main', limits);
        } catch (error) {
          expect(error).toBeInstanceOf(FormatError);
        }
      }),
      { numRuns: runs },
    );
  });

  it('rpmvercmp est antisymétrique et compareRpmEvr un ordre total cohérent', () => {
    const part = fc.stringMatching(/^[a-z0-9.~^+_]{1,8}$/);
    const evr = fc
      .tuple(fc.option(fc.integer({ min: 0, max: 5 }), { nil: undefined }), part, part)
      .map(([epoch, version, release]) => `${epoch === undefined ? '' : `${epoch}:`}${version}-${release}`);
    fc.assert(
      fc.property(part, part, evr, evr, evr, (a, b, x, y, z) => {
        expect(rpmvercmp(a, b)).toBe(-rpmvercmp(b, a) || 0);
        if (compareRpmEvr(x, y) <= 0 && compareRpmEvr(y, z) <= 0) expect(compareRpmEvr(x, z)).toBeLessThanOrEqual(0);
      }),
      { numRuns: runs },
    );
  });
});
