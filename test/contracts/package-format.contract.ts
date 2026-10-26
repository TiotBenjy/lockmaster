import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FormatError } from '../../src/formats/common/errors.js';
import { DEFAULT_LIMITS } from '../../src/formats/common/limits.js';
import { BufferSource } from '../../src/formats/common/source.js';
import type { PackageFormat } from '../../src/formats/package-format.js';

export interface PackageFormatFixtures {
  /** Paquet valide sans script mainteneur. */
  readonly plain: Uint8Array;
  readonly expected: { readonly name: string; readonly version: string; readonly arch: string };
  /** Paquet valide avec un script mainteneur contenant `marker`. */
  readonly withScript: Uint8Array;
  readonly script: string;
  readonly marker: string;
  /** Deux versions valides du format, la première strictement inférieure. */
  readonly versions: readonly [string, string];
}

const options = { limits: DEFAULT_LIMITS };

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Buffer.concat(parts);
}

/** Suite de conformité de `PackageFormat` : deb, rpm et apk la passent. */
export function describePackageFormatContract(format: PackageFormat, fixtures: () => PackageFormatFixtures): void {
  describe(`contrat PackageFormat (${format.name})`, () => {
    it("lit l'identité, la taille et les empreintes du paquet", async () => {
      const { plain, expected } = fixtures();
      const parsed = await format.parse(new BufferSource(plain), options);
      expect(parsed).toMatchObject({ format: format.name, ...expected, size: plain.length, maintainerScripts: [] });
      for (const algorithm of ['md5', 'sha1', 'sha256', 'sha512'] as const) {
        expect(parsed.digests[algorithm]).toBe(createHash(algorithm).update(plain).digest('hex'));
      }
    });

    it('signale les scripts mainteneur (SEC-02)', async () => {
      const { withScript, script } = fixtures();
      expect((await format.parse(new BufferSource(withScript), options)).maintainerScripts).toContain(script);
    });

    it('expose le contenu des scripts dans un flux interne décompressé (SEC-01)', async () => {
      const { withScript, marker } = fixtures();
      const seen: string[] = [];
      for await (const stream of format.innerStreams(new BufferSource(withScript), options)) {
        seen.push((await collect(stream.data)).toString('latin1'));
      }
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.some((content) => content.includes(marker))).toBe(true);
    });

    it('refuse tout paquet tronqué avec une FormatError, jamais autre chose', async () => {
      const { plain } = fixtures();
      for (const length of [0, 1, 7, 8, 60, 68, Math.floor(plain.length / 2), plain.length - 1]) {
        await expect(format.parse(new BufferSource(plain.subarray(0, length)), options)).rejects.toBeInstanceOf(
          FormatError,
        );
      }
    });

    it('refuse un paquet plus gros que maxPackageBytes (FORMAT_LIMIT_EXCEEDED)', async () => {
      const { plain } = fixtures();
      const limits = { ...DEFAULT_LIMITS, maxPackageBytes: plain.length - 1 };
      await expect(format.parse(new BufferSource(plain), { limits })).rejects.toMatchObject({
        code: 'FORMAT_LIMIT_EXCEEDED',
      });
    });

    it("s'arrête sur un signal annulé (FORMAT_ABORTED)", async () => {
      const { plain } = fixtures();
      const signal = AbortSignal.abort();
      await expect(format.parse(new BufferSource(plain), { ...options, signal })).rejects.toMatchObject({
        code: 'FORMAT_ABORTED',
      });
    });

    it('compare les versions : réflexive, antisymétrique, refuse une version invalide', () => {
      const [lower, higher] = fixtures().versions;
      expect(format.compareVersions(lower, lower)).toBe(0);
      expect(format.compareVersions(lower, higher)).toBeLessThan(0);
      expect(format.compareVersions(higher, lower)).toBeGreaterThan(0);
      expect(() => format.compareVersions(lower, '@')).toThrowError(
        expect.objectContaining({ code: 'FORMAT_INVALID' }),
      );
    });
  });
}
