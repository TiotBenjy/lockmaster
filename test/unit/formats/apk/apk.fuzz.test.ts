import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { apkFormat } from '../../../../src/formats/apk/format.js';
import { parseApkDependencies, parsePkgInfo } from '../../../../src/formats/apk/pkginfo.js';
import { compareApkVersion } from '../../../../src/formats/apk/version.js';
import { FormatError } from '../../../../src/formats/common/errors.js';
import { DEFAULT_LIMITS } from '../../../../src/formats/common/limits.js';
import { BufferSource } from '../../../../src/formats/common/source.js';
import { buildApk, signatureEntry } from '../../../fixtures/builders/apk.js';

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

describe('formats/apk (propriétés)', () => {
  const apk = buildApk({ signature: [signatureEntry()], scripts: { '.post-install': 'echo\n' } });

  it("parseApk ne lève qu'une FormatError sur un paquet muté", async () => {
    await fc.assert(
      fc.asyncProperty(mutated(apk), async (bytes) => {
        try {
          const parsed = await apkFormat.parse(new BufferSource(bytes), { limits });
          expect(parsed.name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);
        } catch (error) {
          expect(error).toBeInstanceOf(FormatError);
        }
      }),
      { numRuns: runs },
    );
  });

  it("innerStreams ne lève qu'une FormatError sur un paquet muté", async () => {
    await fc.assert(
      fc.asyncProperty(mutated(apk), async (bytes) => {
        try {
          for await (const stream of apkFormat.innerStreams(new BufferSource(bytes), { limits })) {
            for await (const _chunk of stream.data);
          }
        } catch (error) {
          expect(error).toBeInstanceOf(FormatError);
        }
      }),
      { numRuns: runs },
    );
  });

  it(".PKGINFO, les dépendances et les versions ne lèvent qu'une FormatError", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (text) => {
        onlyFormatErrors(() => parsePkgInfo(Buffer.from(text), limits));
        onlyFormatErrors(() => parseApkDependencies([text]));
        onlyFormatErrors(() => compareApkVersion(text, '1.0'));
      }),
      { numRuns: runs },
    );
  });

  it('compareApkVersion est un ordre total cohérent sur des versions valides', () => {
    const version = fc.stringMatching(/^[0-9]{1,3}(\.[0-9]{1,3}){0,2}[a-c]?(_(alpha|rc|p)[0-9]?)?(-r[0-9])?$/);
    fc.assert(
      fc.property(version, version, version, (a, b, c) => {
        expect(Math.sign(compareApkVersion(a, b))).toBe(-Math.sign(compareApkVersion(b, a)) || 0);
        if (compareApkVersion(a, b) <= 0 && compareApkVersion(b, c) <= 0) {
          expect(compareApkVersion(a, c)).toBeLessThanOrEqual(0);
        }
      }),
      { numRuns: runs },
    );
  });
});
