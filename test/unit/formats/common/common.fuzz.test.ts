import { gzipSync } from 'node:zlib';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { readArMembers } from '../../../../src/formats/common/ar.js';
import { decompressToBuffer } from '../../../../src/formats/common/decompress.js';
import { FormatError } from '../../../../src/formats/common/errors.js';
import { DEFAULT_LIMITS } from '../../../../src/formats/common/limits.js';
import { BufferSource } from '../../../../src/formats/common/source.js';
import { parseTar } from '../../../../src/formats/common/tar.js';
import { buildAr } from '../../../fixtures/builders/ar.js';
import { buildTar } from '../../../fixtures/builders/tar.js';
import { corpusFile } from './corpus.js';

const runs = Number(process.env['FC_NUM_RUNS'] ?? 300);
const TAR_OPTIONS = { maxEntries: 32, maxEntryBytes: 64 * 1024, maxExtendedHeaderBytes: 4096, requireEndMarker: true };

/** Mutation d'un contenu valide : octets remplacés, coupe, ou ajout. */
const mutated = (valid: Uint8Array) =>
  fc
    .record({
      cuts: fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 8 }),
      truncateAt: fc.option(fc.nat(), { nil: undefined }),
    })
    .map(({ cuts, truncateAt }) => {
      const copy = Buffer.from(valid);
      for (const [position, value] of cuts) if (copy.length > 0) copy[position % copy.length] = value;
      return truncateAt === undefined ? copy : copy.subarray(0, truncateAt % (copy.length + 1));
    });

function expectTypedFailure(error: unknown): void {
  expect(error).toBeInstanceOf(FormatError);
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

describe('formats/common (propriétés)', () => {
  const tar = buildTar([
    { path: './control', data: 'Package: a\n' },
    { path: './postinst', data: '#!/bin/sh\n', mode: 0o755, format: 'gnu' },
    { path: './lien', type: '2', linkTarget: 'control' },
  ]);
  const ar = buildAr([
    { name: 'debian-binary', data: Buffer.from('2.0\n') },
    { name: 'control.tar.gz', data: gzipSync(tar) },
  ]);

  it("parseTar ne lève qu'une FormatError et respecte ses bornes", () => {
    fc.assert(
      fc.property(fc.oneof(mutated(tar), fc.uint8Array({ maxLength: 4096 })), (bytes) => {
        try {
          const entries = parseTar(bytes, TAR_OPTIONS);
          expect(entries.length).toBeLessThanOrEqual(TAR_OPTIONS.maxEntries);
          for (const entry of entries) expect(entry.size).toBeLessThanOrEqual(TAR_OPTIONS.maxEntryBytes);
        } catch (error) {
          expectTypedFailure(error);
        }
      }),
      { numRuns: runs },
    );
  });

  it("readArMembers ne lève qu'une FormatError et rend des membres dans les bornes", async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(mutated(ar), fc.uint8Array({ maxLength: 512 })), async (bytes) => {
        try {
          for (const member of await readArMembers(new BufferSource(bytes), { maxMembers: 8 })) {
            expect(member.offset + member.size).toBeLessThanOrEqual(bytes.length);
          }
        } catch (error) {
          expectTypedFailure(error);
        }
      }),
      { numRuns: runs },
    );
  });

  it("la décompression gzip ne lève qu'une FormatError et ne dépasse jamais son budget", async () => {
    const options = { maxOutputBytes: 32 * 1024, limits: DEFAULT_LIMITS };
    await fc.assert(
      fc.asyncProperty(mutated(gzipSync(Buffer.alloc(40_000, 7))), async (bytes) => {
        try {
          expect((await decompressToBuffer(once(bytes), 'gzip', options)).length).toBeLessThanOrEqual(32 * 1024);
        } catch (error) {
          expectTypedFailure(error);
        }
      }),
      { numRuns: runs },
    );
  });

  it.each([
    ['xz', 'xz/text-crc64.xz'],
    ['xz', 'xz/mixed-lc1-lp3-pb0.xz'],
    ['bzip2', 'bzip2/text-1.bz2'],
  ] as const)("le décodeur %s ne lève qu'une FormatError sur un flux muté (%s)", async (compression, file) => {
    const options = { maxOutputBytes: 300 * 1024, limits: DEFAULT_LIMITS };
    await fc.assert(
      fc.asyncProperty(mutated(corpusFile(file)), async (bytes) => {
        try {
          expect((await decompressToBuffer(once(bytes), compression, options)).length).toBeLessThanOrEqual(300 * 1024);
        } catch (error) {
          expectTypedFailure(error);
        }
      }),
      { numRuns: Math.max(20, Math.floor(runs / 10)) },
    );
  });
});
