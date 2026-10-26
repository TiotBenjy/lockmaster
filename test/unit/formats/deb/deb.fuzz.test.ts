import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FormatError } from '../../../../src/formats/common/errors.js';
import { DEFAULT_LIMITS } from '../../../../src/formats/common/limits.js';
import { BufferSource } from '../../../../src/formats/common/source.js';
import { parseControl } from '../../../../src/formats/deb/control.js';
import { debFormat } from '../../../../src/formats/deb/format.js';
import { parseDebRelations } from '../../../../src/formats/deb/relations.js';
import { compareDebVersion } from '../../../../src/formats/deb/version.js';
import { buildDeb } from '../../../fixtures/builders/deb.js';

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

function onlyFormatErrors(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(FormatError);
  }
}

describe('formats/deb (propriétés)', () => {
  it("parseDeb ne lève qu'une FormatError sur un paquet muté, y compris dans le contrôle", async () => {
    const deb = buildDeb({ controlCompression: 'none', dataCompression: 'gzip', controlFiles: { postinst: 'echo\n' } });
    await fc.assert(
      fc.asyncProperty(mutated(deb), async (bytes) => {
        try {
          const parsed = await debFormat.parse(new BufferSource(bytes), { limits });
          expect(parsed.name).toMatch(/^[a-z0-9][a-z0-9+.-]+$/);
        } catch (error) {
          expect(error).toBeInstanceOf(FormatError);
        }
      }),
      { numRuns: runs },
    );
  });

  it("parseControl, les relations et les versions ne lèvent qu'une FormatError", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (text) => {
        onlyFormatErrors(() => parseControl(Buffer.from(text), limits));
        onlyFormatErrors(() => parseDebRelations(text, { alternatives: true }));
        onlyFormatErrors(() => compareDebVersion(text, '1.0'));
      }),
      { numRuns: runs },
    );
  });

  it('compareDebVersion est un ordre total cohérent sur des versions valides', () => {
    const version = fc.stringMatching(/^([0-9]{1,2}:)?[0-9][a-z0-9.+~]{0,6}(-[a-z0-9.+~]{1,4})?$/);
    fc.assert(
      fc.property(version, version, version, (a, b, c) => {
        expect(Math.sign(compareDebVersion(a, b))).toBe(-Math.sign(compareDebVersion(b, a)) || 0);
        if (compareDebVersion(a, b) <= 0 && compareDebVersion(b, c) <= 0) {
          expect(compareDebVersion(a, c)).toBeLessThanOrEqual(0);
        }
      }),
      { numRuns: runs },
    );
  });
});
