import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../../../../src/formats/common/limits.js';
import { BufferSource } from '../../../../src/formats/common/source.js';
import { debFormat } from '../../../../src/formats/deb/format.js';
import { describePackageFormatContract } from '../../../contracts/package-format.contract.js';
import type { ArEntry } from '../../../fixtures/builders/ar.js';
import { buildDeb, DEFAULT_CONTROL, type DebSpec } from '../../../fixtures/builders/deb.js';

const SCRIPT = '#!/bin/sh\necho MARQUEUR-SEC01\n';

describePackageFormatContract(debFormat, () => ({
  plain: buildDeb(),
  expected: { name: 'hello', version: '2.10-3', arch: 'amd64' },
  withScript: buildDeb({ controlFiles: { postinst: SCRIPT } }),
  script: 'postinst',
  marker: 'MARQUEUR-SEC01',
  versions: ['1.0~rc1-1', '1.0-1'],
}));

const parse = (spec: DebSpec = {}) => debFormat.parse(new BufferSource(buildDeb(spec)), { limits: DEFAULT_LIMITS });

async function codeOf(spec: DebSpec): Promise<string> {
  try {
    await parse(spec);
    return 'aucune erreur';
  } catch (error) {
    return (error as { code?: string }).code ?? `erreur sans code : ${String(error)}`;
  }
}

const withField = (name: string, value: string | undefined): DebSpec => {
  const control: Record<string, string> = { ...DEFAULT_CONTROL };
  if (value === undefined) delete control[name];
  else control[name] = value;
  return { control };
};

const gpg = (name: string): ArEntry => ({ name, data: Buffer.from('signature') });

describe('parseDeb : métadonnées', () => {
  it('lit identité, source, relations et champs bruts dans leur ordre', async () => {
    const parsed = await parse();
    expect(parsed).toMatchObject({
      name: 'hello',
      version: '2.10-3',
      arch: 'amd64',
      sourceName: 'hello-src',
      sourceVersion: '2.10-1',
      maintainerScripts: [],
    });
    expect(parsed.depends).toEqual([
      [{ name: 'dpkg', operator: 'ge', version: '1.19' }],
      [{ name: 'libc6', operator: 'ge', version: '2.34' }],
      [{ name: 'libfoo' }, { name: 'libbar', operator: 'lt', version: '2.0' }],
    ]);
    expect(parsed.provides).toEqual([{ name: 'hello-virtual', operator: 'eq', version: '2.10' }]);
    expect(parsed.conflicts).toEqual([{ name: 'hello-old' }, { name: 'hello-plugin', operator: 'lt', version: '1.0' }]);
    expect(parsed.replaces).toEqual([{ name: 'hello-old', operator: 'lt', version: '2.0' }]);
    expect(Object.keys(parsed.control)).toEqual(Object.keys(DEFAULT_CONTROL));
    expect(parsed.control['Description']).toBe(DEFAULT_CONTROL['Description']);
  });

  it('prend le paquet lui-même comme source quand Source est absent ou sans version', async () => {
    expect(await parse(withField('Source', undefined))).toMatchObject({ sourceName: 'hello', sourceVersion: '2.10-3' });
    expect(await parse(withField('Source', 'hello-src'))).toMatchObject({
      sourceName: 'hello-src',
      sourceVersion: '2.10-3',
    });
  });

  it('accepte Architecture: all et les champs facultatifs absents', async () => {
    const minimal = {
      Package: 'hello',
      Version: '1.0',
      Architecture: 'all',
      Maintainer: 'M <m@example.org>',
      Description: 'x',
    };
    expect(await parse({ control: minimal })).toMatchObject({ arch: 'all', depends: [], provides: [], conflicts: [] });
  });

  it('signale les scripts mainteneur dans un ordre fixe', async () => {
    const controlFiles = { triggers: 'interest x', postrm: SCRIPT, preinst: SCRIPT, config: SCRIPT, md5sums: '' };
    expect((await parse({ controlFiles })).maintainerScripts).toEqual(['preinst', 'postrm', 'config', 'triggers']);
  });

  it.each<[string, DebSpec]>([
    ['Package absent', withField('Package', undefined)],
    ['Version absent', withField('Version', undefined)],
    ['Architecture absent', withField('Architecture', undefined)],
    ['Maintainer absent', withField('Maintainer', undefined)],
    ['Maintainer vide', withField('Maintainer', '')],
    ['Description absent', withField('Description', undefined)],
    ['Description sans résumé', withField('Description', '\n suite')],
    ['nom en majuscules', withField('Package', 'Hello')],
    ['nom sur deux lignes', withField('Package', 'hello\n suite')],
    ['version invalide', withField('Version', '1.0@2')],
    ['architecture joker', withField('Architecture', 'any')],
    ['architecture joker composée', withField('Architecture', 'linux-any')],
    ['architecture en majuscules', withField('Architecture', 'Amd64')],
    ['Source invalide', withField('Source', 'hello-src (2.0')],
    ['Installed-Size non numérique', withField('Installed-Size', 'abc')],
    ['Depends invalide', withField('Depends', 'libc6 (>= 2.34')],
    ['Provides avec >=', withField('Provides', 'hello-virtual (>= 2.10)')],
    ['alternative dans Conflicts', withField('Conflicts', 'a0 | b0')],
    ['Recommends invalide', withField('Recommends', 'A0')],
    ['texte de contrôle invalide', { control: 'Package: hello\n# commentaire\n' }],
    ...[
      'Filename',
      'size',
      'MD5sum',
      'SHA1',
      'sha256',
      'SHA512',
      'Description-md5',
      'Status',
      'Config-Version',
      'Conffiles',
    ].map((field): [string, DebSpec] => [
      `champ réservé à l'archive ou à dpkg (${field})`,
      withField(field, 'pool/x/openssl.deb'),
    ]),
  ])('refuse : %s (FORMAT_INVALID)', async (_label, spec) => {
    expect(await codeOf(spec)).toBe('FORMAT_INVALID');
  });
});

describe('parseDeb : archive ar', () => {
  it.each(['none', 'gzip', 'xz', 'zstd'] as const)('accepte control.tar compressé en %s', async (compression) => {
    expect((await parse({ controlCompression: compression })).name).toBe('hello');
  });

  it.each(['none', 'gzip', 'xz', 'zstd', 'bzip2'] as const)('accepte data.tar compressé en %s', async (compression) => {
    expect((await parse({ dataCompression: compression })).name).toBe('hello');
  });

  it('accepte une version de format 2.x avec des lignes en plus et des signatures _gpg*', async () => {
    expect((await parse({ debianBinary: '2.1\nextension\n' })).name).toBe('hello');
    const signed = await parse({
      members: ({ binary, control, data }) => [binary, gpg('_gpgbuilder'), control, data, gpg('_gpgorigin')],
    });
    expect(signed.name).toBe('hello');
  });

  it.each<[string, DebSpec, string]>([
    ['data.tar en lzma historique', { dataCompression: 'lzma' }, 'FORMAT_UNSUPPORTED_COMPRESSION'],
    ['control.tar en bzip2', { controlCompression: 'bzip2' }, 'FORMAT_UNSUPPORTED_COMPRESSION'],
    ['format 3.0', { debianBinary: '3.0\n' }, 'FORMAT_INVALID'],
    ['debian-binary sans fin de ligne', { debianBinary: '2.0' }, 'FORMAT_INVALID'],
    ['debian-binary vide', { debianBinary: '' }, 'FORMAT_INVALID'],
    ['debian-binary trop long', { debianBinary: `2.0\n${'x'.repeat(300)}\n` }, 'FORMAT_INVALID'],
    ['contrôle absent', { members: ({ binary, data }) => [binary, data] }, 'FORMAT_INVALID'],
    ['données absentes', { members: ({ binary, control }) => [binary, control] }, 'FORMAT_INVALID'],
    ['données avant contrôle', { members: ({ binary, control, data }) => [binary, data, control] }, 'FORMAT_INVALID'],
    [
      'contrôle en double',
      { members: ({ binary, control, data }) => [binary, control, control, data] },
      'FORMAT_INVALID',
    ],
    [
      'debian-binary pas en tête',
      { members: ({ binary, control, data }) => [control, binary, data] },
      'FORMAT_INVALID',
    ],
    [
      'membre inconnu',
      { members: ({ binary, control, data }) => [binary, control, data, gpg('extra')] },
      'FORMAT_INVALID',
    ],
    [
      'membre _ non signature',
      { members: ({ binary, control, data }) => [binary, gpg('_autre'), control, data] },
      'FORMAT_INVALID',
    ],
  ])('refuse : %s', async (_label, spec, code) => {
    expect(await codeOf(spec)).toBe(code);
  });
});

describe('parseDeb : control.tar', () => {
  const control = { path: './control', data: 'Package: hello\n' };
  it.each<[string, DebSpec]>([
    ['contrôle absent', { controlEntries: [{ path: './', type: '5' }] }],
    ['fichier inconnu', { controlFiles: { evil: SCRIPT } }],
    [
      'sous-dossier',
      { controlEntries: [control, { path: './sub/', type: '5' }, { path: './sub/postinst', data: SCRIPT }] },
    ],
    ['lien symbolique', { controlEntries: [control, { path: './postinst', type: '2', linkTarget: '/tmp/x' }] }],
    ['lien dur', { controlEntries: [control, { path: './postinst', type: '1', linkTarget: './control' }] }],
    ['périphérique', { controlEntries: [control, { path: './postinst', type: '3' }] }],
    [
      'script en double',
      { controlEntries: [control, { path: './postinst', data: SCRIPT }, { path: 'postinst', data: SCRIPT }] },
    ],
    ['chemin absolu', { controlEntries: [{ path: '/control', data: 'Package: hello\n' }] }],
    ['remontée de dossier', { controlEntries: [control, { path: './../postinst', data: SCRIPT }] }],
  ])('refuse : %s (FORMAT_INVALID)', async (_label, spec) => {
    expect(await codeOf(spec)).toBe('FORMAT_INVALID');
  });

  it('refuse une bombe de décompression dans control.tar (FORMAT_LIMIT_EXCEEDED)', async () => {
    const bomb = { path: './md5sums', data: Buffer.alloc(11 * 1024 * 1024) };
    const spec: DebSpec = { controlEntries: [{ path: './control', data: 'Package: hello\n' }, bomb] };
    expect(await codeOf(spec)).toBe('FORMAT_LIMIT_EXCEEDED');
  });
});

describe('debInnerStreams (SEC-01)', () => {
  it('rend control.tar puis data.tar décompressés, quelle que soit la compression', async () => {
    for (const compression of ['gzip', 'xz', 'zstd', 'bzip2', 'none'] as const) {
      const deb = buildDeb({ dataCompression: compression, controlFiles: { postinst: SCRIPT } });
      const names: string[] = [];
      const contents: string[] = [];
      for await (const stream of debFormat.innerStreams(new BufferSource(deb), { limits: DEFAULT_LIMITS })) {
        names.push(stream.name);
        const parts: Uint8Array[] = [];
        for await (const chunk of stream.data) parts.push(chunk);
        contents.push(Buffer.concat(parts).toString('latin1'));
      }
      expect(names).toEqual(['control.tar', 'data.tar']);
      expect(contents[0]).toContain('MARQUEUR-SEC01');
      expect(contents[1]).toContain('echo bonjour');
    }
  });

  it('refuse une compression inconnue avant de rendre un flux (FORMAT_UNSUPPORTED_COMPRESSION)', async () => {
    const deb = buildDeb({ dataCompression: 'lzma' });
    const iterate = async (): Promise<void> => {
      for await (const stream of debFormat.innerStreams(new BufferSource(deb), { limits: DEFAULT_LIMITS })) {
        for await (const _chunk of stream.data) {
          // consommation complète
        }
      }
    };
    await expect(iterate()).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED_COMPRESSION' });
  });
});
