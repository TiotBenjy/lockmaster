import { describe, expect, it } from 'vitest';
import { parseTar, safeRelativePath, type TarOptions } from '../../../../src/formats/common/tar.js';
import { buildTar, paxRecords, type TarSpec, tarEntry } from '../../../fixtures/builders/tar.js';

/** Chemin de plus de 100 octets : le champ ustar n'en garde que le début (comme GNU tar). */
const LONG = `./${'dossier/'.repeat(14)}fichier`;

const OPTIONS: TarOptions = {
  maxEntries: 16,
  maxEntryBytes: 4096,
  maxExtendedHeaderBytes: 1024,
  requireEndMarker: true,
};

const text = (bytes: Uint8Array | undefined): string => Buffer.from(bytes ?? new Uint8Array(0)).toString('utf8');

function codeOf(bytes: Uint8Array, options: Partial<TarOptions> = {}): string {
  try {
    parseTar(bytes, { ...OPTIONS, ...options });
    return 'aucune erreur';
  } catch (error) {
    return (error as { code?: string }).code ?? `erreur sans code : ${String(error)}`;
  }
}

describe('parseTar', () => {
  it('lit fichiers, dossiers et liens en ustar et en GNU, avec leur contenu', () => {
    const archive = buildTar([
      { path: './', type: '5', mode: 0o755 },
      { path: './control', data: 'Package: hello\n' },
      { path: './postinst', data: '#!/bin/sh\n', mode: 0o755, format: 'gnu' },
      { path: './lien', type: '2', linkTarget: 'control' },
      { path: './dur', type: '1', linkTarget: './control' },
    ]);
    const entries = parseTar(archive, OPTIONS);
    expect(entries.map(({ path, type, mode, size }) => ({ path, type, mode, size }))).toEqual([
      { path: './', type: 'directory', mode: 0o755, size: 0 },
      { path: './control', type: 'file', mode: 0o644, size: 15 },
      { path: './postinst', type: 'file', mode: 0o755, size: 10 },
      { path: './lien', type: 'symlink', mode: 0o644, size: 0 },
      { path: './dur', type: 'hardlink', mode: 0o644, size: 0 },
    ]);
    expect(text(entries[1]?.data)).toBe('Package: hello\n');
    expect(entries[3]?.linkTarget).toBe('control');
    expect(entries[4]?.linkTarget).toBe('./control');
  });

  it('assemble préfixe ustar et nom', () => {
    const [entry] = parseTar(buildTar([{ path: 'fichier', prefix: 'un/dossier', data: 'x' }]), OPTIONS);
    expect(entry?.path).toBe('un/dossier/fichier');
  });

  it("accepte une taille pax égale à celle de l'en-tête ustar", () => {
    const archive = buildTar([
      { path: 'PaxHeader', type: 'x', data: paxRecords({ size: '7' }) },
      { path: 'a', data: 'contenu' },
    ]);
    expect(text(parseTar(archive, OPTIONS)[0]?.data)).toBe('contenu');
  });

  it('applique les en-têtes pax (path, linkpath, size) et les noms longs GNU', () => {
    const long = `./${'d/'.repeat(80)}fichier`;
    const archive = buildTar([
      { path: 'PaxHeader', type: 'x', data: paxRecords({ path: long, mtime: '1.5' }) },
      { path: long, data: 'contenu' },
      { path: './@LongLink', type: 'L', data: `${long}-gnu\0`, format: 'gnu' },
      { path: `${long}-gnu`, data: 'gnu', format: 'gnu' },
      { path: 'PaxHeader', type: 'x', data: paxRecords({ linkpath: long }) },
      { path: './lien', type: '2', linkTarget: long },
    ]);
    const entries = parseTar(archive, OPTIONS);
    expect(entries.map((entry) => entry.path)).toEqual([long, `${long}-gnu`, './lien']);
    expect(text(entries[0]?.data)).toBe('contenu');
    expect(entries[2]?.linkTarget).toBe(long);
  });

  it("ignore l'en-tête pax global et n'applique un en-tête pax qu'à l'entrée suivante", () => {
    const archive = buildTar([
      { path: 'global', type: 'g', data: paxRecords({ comment: 'x' }) },
      { path: 'PaxHeader', type: 'x', data: paxRecords({ path: LONG }) },
      { path: LONG, data: '1' },
      { path: 'b', data: '2' },
    ]);
    expect(parseTar(archive, OPTIONS).map((entry) => entry.path)).toEqual([LONG, 'b']);
  });

  it('accepte une archive sans blocs de fin si requireEndMarker est faux (contrôle apk)', () => {
    const archive = buildTar([{ path: '.PKGINFO', data: 'pkgname = a\n' }], { endMarker: false });
    expect(codeOf(archive)).toBe('FORMAT_TRUNCATED');
    expect(parseTar(archive, { ...OPTIONS, requireEndMarker: false }).map((entry) => entry.path)).toEqual(['.PKGINFO']);
  });

  it("refuse un en-tête pax ou GNU qui contredit l'en-tête ustar (lecteurs divergents)", () => {
    const cases: TarSpec[][] = [
      [
        { path: 'P', type: 'x', data: paxRecords({ path: 'cache' }) },
        { path: './postinst', data: '#!/bin/sh\n' },
      ],
      [
        { path: 'P', type: 'x', data: paxRecords({ path: `${LONG}x` }) },
        { path: './postinst', data: '#!/bin/sh\n' },
      ],
      [
        { path: 'P', type: 'x', data: paxRecords({ linkpath: 'autre' }) },
        { path: 'l', type: '2', linkTarget: 'cible' },
      ],
      [
        { path: 'L', type: 'L', data: `${LONG}y\0`, format: 'gnu' },
        { path: './postinst', format: 'gnu' },
      ],
      [
        { path: 'K', type: 'K', data: 'autre\0', format: 'gnu' },
        { path: 'l', type: '2', linkTarget: 'cible', format: 'gnu' },
      ],
      [
        { path: 'P', type: 'x', data: paxRecords({ size: '1024' }) },
        { path: './postinst', data: '#!/bin/sh\n' },
      ],
    ];
    for (const specs of cases) expect(codeOf(buildTar(specs))).toBe('FORMAT_INVALID');
  });

  it('ne laisse pas une taille pax en attente désynchroniser la lecture (constat de revue)', () => {
    const script = Buffer.concat([
      Buffer.from('#!/bin/sh\nrm -rf /\n'.padEnd(512, '\0')),
      tarEntry({ path: './md5sums' }),
    ]);
    const archive = Buffer.concat([
      tarEntry({ path: './control', data: 'Package: a\n' }),
      tarEntry({ path: 'P', type: 'x', data: paxRecords({ size: '1024' }) }),
      tarEntry({ path: 'G', type: 'g', data: '' }),
      tarEntry({ path: './postinst', data: script }),
      Buffer.alloc(1024),
    ]);
    expect(codeOf(archive)).toBe('FORMAT_INVALID');
  });

  it('refuse un en-tête étendu répété avant la même entrée', () => {
    const twice = buildTar([
      { path: 'P', type: 'x', data: paxRecords({ mtime: '1' }) },
      { path: 'P', type: 'x', data: paxRecords({ mtime: '2' }) },
      { path: 'a', data: 'x' },
    ]);
    expect(codeOf(twice)).toBe('FORMAT_INVALID');
  });

  it('refuse un en-tête pax global qui porte path, linkpath ou size', () => {
    for (const key of ['path', 'linkpath', 'size']) {
      const archive = buildTar([
        { path: 'G', type: 'g', data: paxRecords({ [key]: '1' }) },
        { path: 'a', data: 'x' },
      ]);
      expect(codeOf(archive)).toBe('FORMAT_INVALID');
    }
  });

  it('refuse des données après le premier bloc nul (entrée cachée)', () => {
    const hidden = Buffer.concat([
      tarEntry({ path: '.PKGINFO', data: 'pkgname = a\n' }),
      Buffer.alloc(512),
      tarEntry({ path: '.pre-install', data: '#!/bin/sh\n' }),
    ]);
    expect(codeOf(hidden, { requireEndMarker: false })).toBe('FORMAT_INVALID');
    expect(codeOf(Buffer.concat([hidden, Buffer.alloc(1024)]))).toBe('FORMAT_INVALID');
    const trailing = Buffer.concat([buildTar([{ path: 'a', data: 'x' }]), Buffer.from('déchets')]);
    expect(codeOf(trailing)).toBe('FORMAT_INVALID');
  });

  it('accepte une archive vide (deux blocs nuls) et ignore le remplissage après la fin', () => {
    expect(parseTar(Buffer.concat([buildTar([]), Buffer.alloc(8192)]), OPTIONS)).toEqual([]);
  });

  it('lit la taille en base 256 (extension GNU des gros fichiers)', () => {
    const entry = Buffer.from(tarEntry({ path: 'gros', data: 'abc', format: 'gnu' }));
    entry.fill(0, 124, 136);
    entry[124] = 0x80;
    entry[135] = 3;
    rewriteChecksum(entry);
    const [parsed] = parseTar(Buffer.concat([entry, Buffer.alloc(1024)]), OPTIONS);
    expect(text(parsed?.data)).toBe('abc');
  });

  const malformed: [string, TarSpec[] | Uint8Array][] = [
    ['somme de contrôle fausse', [{ path: 'a', data: 'x', corruptChecksum: true }]],
    ['taille non octale', [{ path: 'a', data: 'x', declaredSize: '00000000009\0' }]],
    ['type inconnu', [{ path: 'a', type: 'S' }]],
    ['dossier avec des données', [{ path: 'd/', type: '5', data: 'x' }]],
    ['lien symbolique avec des données', [{ path: 'l', type: '2', linkTarget: 'a', data: 'x' }]],
    ['chemin vide', [{ path: '', data: 'x' }]],
    ['UTF-8 invalide dans le chemin', [{ path: '\uFFFD', data: 'x' }]],
    ['pax mal formé', [{ path: 'P', type: 'x', data: '5 a=b\n' }, { path: 'a' }]],
    ['pax sans « = »', [{ path: 'P', type: 'x', data: '7 path\n' }, { path: 'a' }]],
    ['taille pax non décimale', [{ path: 'P', type: 'x', data: paxRecords({ size: '1e3' }) }, { path: 'a' }]],
    ["pax en fin d'archive", [{ path: 'P', type: 'x', data: paxRecords({ path: 'x' }) }]],
    ['pax sans longueur', [{ path: 'P', type: 'x', data: ' path=x\n' }, { path: 'a' }]],
    ['pax avec un octet nul', [{ path: 'P', type: 'x', data: '12 path=a\0b\n' }, { path: 'a' }]],
    ['magie absente (tar v7)', v7Header()],
    ['taille en base 256 hors limites', base256Overflow()],
  ];

  it('applique un nom de lien long GNU (K)', () => {
    const target = `./${'cible/'.repeat(30)}fin`;
    const archive = buildTar([
      { path: './@LongLink', type: 'K', data: `${target}\0`, format: 'gnu' },
      { path: './lien', type: '2', linkTarget: target, format: 'gnu' },
    ]);
    expect(parseTar(archive, OPTIONS)[0]?.linkTarget).toBe(target);
  });

  it.each(malformed)('rejette : %s (FORMAT_INVALID)', (_label, specs) => {
    const bytes = specs instanceof Uint8Array ? specs : buildTar(specs);
    expect(codeOf(fixInvalidUtf8(bytes))).toBe('FORMAT_INVALID');
  });

  it.each([
    ['en-tête tronqué', buildTar([{ path: 'a', data: 'x' }]).subarray(0, 300)],
    ['données tronquées', buildTar([{ path: 'a', data: 'x'.repeat(2000) }]).subarray(0, 1536)],
    ['taille déclarée au-delà de la fin', buildTar([{ path: 'a', data: 'x', declaredSize: '00000077777\0' }])],
  ])('rejette : %s (FORMAT_TRUNCATED)', (_label, bytes) => {
    expect(codeOf(bytes)).toBe('FORMAT_TRUNCATED');
  });

  it.each([
    ["trop d'entrées", buildTar(Array.from({ length: 17 }, (_, index) => ({ path: `f${index}` }))), {}],
    ['fichier trop gros', buildTar([{ path: 'a', data: 'x'.repeat(4097) }]), {}],
    ['en-tête pax trop gros', buildTar([{ path: 'P', type: 'x', data: paxRecords({ path: 'x'.repeat(1100) }) }]), {}],
    ['nom long GNU trop gros', buildTar([{ path: 'L', type: 'L', data: 'x'.repeat(1100), format: 'gnu' }]), {}],
  ])('rejette : %s (FORMAT_LIMIT_EXCEEDED)', (_label, bytes, options) => {
    expect(codeOf(bytes, options)).toBe('FORMAT_LIMIT_EXCEEDED');
  });

  it("s'arrête sur un signal annulé (FORMAT_ABORTED)", () => {
    expect(codeOf(buildTar([{ path: 'a' }]), { signal: AbortSignal.abort() })).toBe('FORMAT_ABORTED');
  });
});

describe('safeRelativePath', () => {
  it.each([
    ['./control', 'control'],
    ['control', 'control'],
    ['./usr/bin/x', 'usr/bin/x'],
    ['./', ''],
    ['.', ''],
    ['./a//b/', 'a/b'],
  ])('normalise %s en « %s »', (input, expected) => {
    expect(safeRelativePath(input)).toBe(expected);
  });

  it.each(['/etc/passwd', '../x', './a/../../x', 'a/..', 'a\\b', 'a\nb', 'a\u0085b', 'post\u202Einst', 'a\u2066b'])(
    'refuse %s (FORMAT_INVALID)',
    (input) => {
      expect(() => safeRelativePath(input)).toThrowError(expect.objectContaining({ code: 'FORMAT_INVALID' }));
    },
  );
});

function rewriteChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  const sum = header.subarray(0, 512).reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
}

function base256Overflow(): Uint8Array {
  const entry = Buffer.from(tarEntry({ path: 'gros', data: 'abc', format: 'gnu' }));
  entry.fill(0xff, 124, 136);
  entry[124] = 0x80;
  rewriteChecksum(entry);
  return Buffer.concat([entry, Buffer.alloc(1024)]);
}

function v7Header(): Uint8Array {
  const entry = Buffer.from(tarEntry({ path: 'a', data: 'x' }));
  entry.fill(0, 257, 512);
  rewriteChecksum(entry);
  return Buffer.concat([entry, Buffer.alloc(1024)]);
}

/** Remplace le caractère de substitution U+FFFD écrit par le générateur par un octet 0xff isolé. */
function fixInvalidUtf8(bytes: Uint8Array): Uint8Array {
  const copy = Buffer.from(bytes);
  const marker = Buffer.from('\uFFFD', 'utf8');
  const index = copy.indexOf(marker);
  if (index < 0 || index >= 100) return copy;
  copy.fill(0, index, index + marker.length);
  copy[index] = 0xff;
  rewriteChecksum(copy);
  return copy;
}
