import { describe, expect, it } from 'vitest';
import { readArMembers } from '../../../../src/formats/common/ar.js';
import { BufferSource } from '../../../../src/formats/common/source.js';
import { arHeader, buildAr } from '../../../fixtures/builders/ar.js';

const text = (value: string): Uint8Array => Buffer.from(value, 'latin1');
const MAGIC = text('!<arch>\n');

async function codeOf(bytes: Uint8Array, maxMembers = 8): Promise<string> {
  try {
    await readArMembers(new BufferSource(bytes), { maxMembers });
    return 'aucune erreur';
  } catch (error) {
    return (error as { code?: string }).code ?? 'erreur sans code';
  }
}

describe('readArMembers', () => {
  it('liste les membres avec leur position et leur taille, y compris les tailles impaires', async () => {
    const archive = buildAr([
      { name: 'debian-binary', data: text('2.0\n') },
      { name: 'control.tar.gz', data: text('abc') },
      { name: 'data.tar.xz', data: text('defgh') },
    ]);
    const members = await readArMembers(new BufferSource(archive), { maxMembers: 8 });
    expect(members.map(({ name, size }) => ({ name, size }))).toEqual([
      { name: 'debian-binary', size: 4 },
      { name: 'control.tar.gz', size: 3 },
      { name: 'data.tar.xz', size: 5 },
    ]);
    for (const [index, member] of members.entries()) {
      const expected = ['2.0\n', 'abc', 'defgh'][index] ?? '';
      expect(Buffer.from(archive.subarray(member.offset, member.offset + member.size)).toString('latin1')).toBe(
        expected,
      );
    }
  });

  it("accepte les noms GNU terminés par « / » et un dernier membre sans octet d'alignement", async () => {
    const archive = buildAr([{ name: 'debian-binary', data: text('2.0') }], { gnuNames: true, omitFinalPad: true });
    const members = await readArMembers(new BufferSource(archive), { maxMembers: 8 });
    expect(members).toEqual([{ name: 'debian-binary', offset: 68, size: 3 }]);
  });

  it('accepte une archive sans membre', async () => {
    expect(await readArMembers(new BufferSource(MAGIC), { maxMembers: 8 })).toEqual([]);
  });

  it.each([
    ['magie absente', text('!<arch>X')],
    ['magie trop courte', text('!<ar')],
    ["fin d'en-tête incorrecte", Buffer.concat([MAGIC, arHeader({ name: 'a', size: '0', magic: 'XX' })])],
    ['taille non numérique', Buffer.concat([MAGIC, arHeader({ name: 'a', size: '1e3' })])],
    ['taille négative', Buffer.concat([MAGIC, arHeader({ name: 'a', size: '-1' })])],
    ['taille vide', Buffer.concat([MAGIC, arHeader({ name: 'a', size: '' })])],
    ['table de symboles GNU « / »', Buffer.concat([MAGIC, arHeader({ name: '/', size: '0' })])],
    ['nom long GNU « /12 »', Buffer.concat([MAGIC, arHeader({ name: '/12', size: '0' })])],
    ['nom avec chemin', Buffer.concat([MAGIC, arHeader({ name: '../x', size: '0' })])],
    ['nom vide', Buffer.concat([MAGIC, arHeader({ name: '', size: '0' })])],
    ['nom non ASCII', Buffer.concat([MAGIC, arHeader({ name: 'café', size: '0' })])],
    [
      "octet d'alignement incorrect",
      Buffer.concat([
        buildAr([{ name: 'a', data: text('x') }], { omitFinalPad: true }),
        text('Y'),
        arHeader({ name: 'b', size: '0' }),
      ]),
    ],
  ])('rejette : %s (FORMAT_INVALID)', async (_label, bytes) => {
    expect(await codeOf(bytes)).toBe('FORMAT_INVALID');
  });

  it.each([
    ['en-tête tronqué', Buffer.concat([MAGIC, arHeader({ name: 'a', size: '4' }).subarray(0, 30)])],
    ['données plus courtes que la taille', Buffer.concat([MAGIC, arHeader({ name: 'a', size: '10' }), text('abc')])],
    ['taille gigantesque', Buffer.concat([MAGIC, arHeader({ name: 'a', size: '9999999999' })])],
  ])('rejette : %s (FORMAT_TRUNCATED)', async (_label, bytes) => {
    expect(await codeOf(bytes)).toBe('FORMAT_TRUNCATED');
  });

  it('rejette une archive qui a plus de membres que permis (FORMAT_LIMIT_EXCEEDED)', async () => {
    const archive = buildAr(Array.from({ length: 4 }, (_, index) => ({ name: `m${index}`, data: text('') })));
    expect(await codeOf(archive, 3)).toBe('FORMAT_LIMIT_EXCEEDED');
    expect(await codeOf(archive, 4)).toBe('aucune erreur');
  });

  it('transmet le signal à chaque lecture de la source', async () => {
    const archive = new BufferSource(
      buildAr([
        { name: 'a', data: text('x') },
        { name: 'b', data: text('yz') },
      ]),
    );
    const signals: (AbortSignal | undefined)[] = [];
    const spy = {
      size: archive.size,
      read: (offset: number, length: number, signal?: AbortSignal) => {
        signals.push(signal);
        return archive.read(offset, length, signal);
      },
      stream: (offset: number, length: number, signal?: AbortSignal) => archive.stream(offset, length, signal),
    };
    const { signal } = new AbortController();
    await readArMembers(spy, { maxMembers: 8, signal });
    expect(signals.length).toBeGreaterThan(2);
    expect(signals.every((received) => received === signal)).toBe(true);
  });

  it("s'arrête sur un signal annulé (FORMAT_ABORTED)", async () => {
    const archive = buildAr([{ name: 'a', data: text('x') }]);
    await expect(
      readArMembers(new BufferSource(archive), { maxMembers: 8, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'FORMAT_ABORTED' });
  });
});
