import { randomBytes } from 'node:crypto';
import { crc32, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readGzipMember } from '../../../../src/formats/common/gzip-member.js';
import { BufferSource } from '../../../../src/formats/common/source.js';

const options = { maxOutputBytes: 1024 * 1024 };

async function codeOf(bytes: Uint8Array, offset = 0, maxOutputBytes = options.maxOutputBytes): Promise<string> {
  try {
    await readGzipMember(new BufferSource(bytes), offset, { maxOutputBytes });
    return 'aucune erreur';
  } catch (error) {
    return (error as { code?: string }).code ?? `erreur sans code : ${String(error)}`;
  }
}

/** Membre gzip avec les champs facultatifs de la RFC 1952 (FEXTRA, FNAME, FCOMMENT, FHCRC). */
function withOptionalFields(payload: Uint8Array, flags: number): Buffer {
  const plain = gzipSync(payload);
  const parts: Buffer[] = [Buffer.from([0x1f, 0x8b, 0x08, flags, 0, 0, 0, 0, 0, 3])];
  if (flags & 4) parts.push(Buffer.from([3, 0, 0x41, 0x42, 0x43]));
  if (flags & 8) parts.push(Buffer.from('nom.tar\0', 'latin1'));
  if (flags & 16) parts.push(Buffer.from('commentaire\0', 'latin1'));
  if (flags & 2) {
    const header = Buffer.concat(parts);
    const crc = Buffer.alloc(2);
    crc.writeUInt16LE(crc32(header) & 0xffff);
    parts.push(crc);
  }
  return Buffer.concat([...parts, plain.subarray(10)]);
}

describe('readGzipMember', () => {
  const payload = randomBytes(50_000);
  const first = gzipSync(payload);
  const second = gzipSync(Buffer.from('second membre'));
  const both = Buffer.concat([first, second]);

  it("rend le contenu et la longueur exacte du membre, suivi ou non d'un autre", async () => {
    const member = await readGzipMember(new BufferSource(both), 0, options);
    expect(Buffer.from(member.data).equals(payload)).toBe(true);
    expect(member.length).toBe(first.length);
    const next = await readGzipMember(new BufferSource(both), member.length, options);
    expect(Buffer.from(next.data).toString()).toBe('second membre');
    expect(next.offset + next.length).toBe(both.length);
  });

  it("lit les champs facultatifs de l'en-tête", async () => {
    for (const flags of [4, 8, 16, 2, 2 | 4 | 8 | 16]) {
      const bytes = withOptionalFields(Buffer.from('contenu'), flags);
      const member = await readGzipMember(new BufferSource(bytes), 0, options);
      expect(Buffer.from(member.data).toString()).toBe('contenu');
      expect(member.length).toBe(bytes.length);
    }
  });

  it.each<[string, Uint8Array]>([
    ['magie absente', Buffer.from('pas du gzip du tout')],
    ['méthode autre que deflate', Buffer.from([0x1f, 0x8b, 0x07, 0, 0, 0, 0, 0, 0, 3, 0, 0])],
    ['drapeaux réservés', Buffer.from([0x1f, 0x8b, 0x08, 0x20, 0, 0, 0, 0, 0, 3, 0, 0])],
    [
      "CRC d'en-tête faux",
      (() => {
        const bytes = withOptionalFields(Buffer.from('x'), 2);
        bytes[10] = (bytes[10] ?? 0) ^ 0xff;
        return bytes;
      })(),
    ],
  ])('refuse : %s (FORMAT_INVALID)', async (_label, bytes) => {
    expect(await codeOf(bytes)).toBe('FORMAT_INVALID');
  });

  it.each<[string, Uint8Array]>([
    ['données compressées tronquées', first.subarray(0, 2000)],
    ['en-tête tronqué', first.subarray(0, 5)],
    ['nom sans fin', Buffer.from([0x1f, 0x8b, 0x08, 8, 0, 0, 0, 0, 0, 3, 0x61, 0x62])],
    ['champ FEXTRA tronqué', Buffer.from([0x1f, 0x8b, 0x08, 4, 0, 0, 0, 0, 0, 3, 5])],
    ["CRC d'en-tête tronqué", Buffer.from([0x1f, 0x8b, 0x08, 2, 0, 0, 0, 0, 0, 3, 1])],
    ['en-tête sans données', Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3])],
    ['bloc deflate invalide', Buffer.concat([first.subarray(0, 10), Buffer.from([0xff, 0xff, 0xff, 0xff])])],
    [
      'CRC des données faux',
      (() => {
        const bytes = Buffer.from(first);
        bytes[bytes.length - 8] = (bytes[bytes.length - 8] ?? 0) ^ 1;
        return bytes;
      })(),
    ],
    [
      'taille finale fausse',
      (() => {
        const bytes = Buffer.from(first);
        bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
        return bytes;
      })(),
    ],
    ['enveloppe finale absente', first.subarray(0, first.length - 4)],
  ])('refuse : %s (FORMAT_CORRUPT_STREAM)', async (_label, bytes) => {
    expect(await codeOf(bytes)).toBe('FORMAT_CORRUPT_STREAM');
  });

  it('refuse une sortie au-delà du budget (FORMAT_LIMIT_EXCEEDED)', async () => {
    expect(await codeOf(gzipSync(Buffer.alloc(2 * 1024 * 1024)))).toBe('FORMAT_LIMIT_EXCEEDED');
  });

  it('refuse un membre qui commence au-delà de la fin (FORMAT_TRUNCATED)', async () => {
    expect(await codeOf(first, first.length)).toBe('FORMAT_TRUNCATED');
  });
});
