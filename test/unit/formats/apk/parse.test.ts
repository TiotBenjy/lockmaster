import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { apkFormat } from '../../../../src/formats/apk/format.js';
import { readGzipMember } from '../../../../src/formats/common/gzip-member.js';
import { DEFAULT_LIMITS } from '../../../../src/formats/common/limits.js';
import { BufferSource } from '../../../../src/formats/common/source.js';
import { describePackageFormatContract } from '../../../contracts/package-format.contract.js';
import {
  type ApkSpec,
  buildApk,
  DEFAULT_DATA,
  DEFAULT_PKGINFO,
  signatureEntry,
} from '../../../fixtures/builders/apk.js';
import { buildTar } from '../../../fixtures/builders/tar.js';

const SCRIPT = '#!/bin/sh\necho MARQUEUR-SEC01\n';

describePackageFormatContract(apkFormat, () => ({
  plain: buildApk(),
  expected: { name: 'hello', version: '2.10-r3', arch: 'x86_64' },
  withScript: buildApk({ scripts: { '.post-install': SCRIPT } }),
  script: '.post-install',
  marker: 'MARQUEUR-SEC01',
  versions: ['1.0_rc1-r0', '1.0-r0'],
}));

const options = { limits: DEFAULT_LIMITS };
const parse = (spec: ApkSpec = {}) => apkFormat.parse(new BufferSource(buildApk(spec)), options);

async function codeOf(spec: ApkSpec | Uint8Array): Promise<string> {
  try {
    await apkFormat.parse(new BufferSource(spec instanceof Uint8Array ? spec : buildApk(spec)), options);
    return 'aucune erreur';
  } catch (error) {
    return (error as { code?: string }).code ?? `erreur sans code : ${String(error)}`;
  }
}

const withLine = (key: string, value: string | undefined): ApkSpec => ({
  pkginfo:
    value === undefined
      ? DEFAULT_PKGINFO.filter(([name]) => name !== key)
      : [...DEFAULT_PKGINFO.filter(([name]) => name !== key), [key, value]],
});

describe('parseApk : métadonnées', () => {
  it('lit identité, origine, relations, identifiant C: et champs bruts', async () => {
    const bytes = buildApk();
    const parsed = await apkFormat.parse(new BufferSource(bytes), options);
    expect(parsed).toMatchObject({
      name: 'hello',
      version: '2.10-r3',
      arch: 'x86_64',
      sourceName: 'hello-src',
      sourceVersion: '2.10-r3',
      maintainerScripts: [],
      signatures: [],
    });
    expect(parsed.depends).toEqual([
      [{ name: 'so:libc.musl-x86_64.so.1' }],
      [{ name: 'busybox', operator: 'ge', version: '1.36' }],
    ]);
    expect(parsed.conflicts).toEqual([{ name: 'hello-old' }]);
    expect(parsed.provides).toEqual([{ name: 'cmd:hello', operator: 'eq', version: '2.10-r3' }]);
    expect(parsed.replaces).toEqual([{ name: 'hello-legacy' }]);
    expect(parsed.control['install_if']).toBe('hello-base=2.10-r3 locale');
    expect(parsed.indexChecksum).toMatch(/^Q1[A-Za-z0-9+/]{27}=$/);
  });

  it('calcule C: = Q1 + base64(sha1 du membre contrôle compressé)', async () => {
    const valid = buildApk();
    const parsed = await apkFormat.parse(new BufferSource(valid), options);
    const control = await readGzipMember(new BufferSource(valid), 0, { maxOutputBytes: 1024 * 1024 });
    const expected = createHash('sha1').update(valid.subarray(0, control.length)).digest('base64');
    expect(parsed.indexChecksum).toBe(`Q1${expected}`);
  });

  it('lit les signatures abuild (algorithme et nom de clé) et les exclut de C:', async () => {
    const signed = buildApk({
      signature: [signatureEntry('RSA256', 'equipe-6543.rsa.pub'), signatureEntry('RSA', 'ancienne.rsa.pub')],
    });
    const parsed = await apkFormat.parse(new BufferSource(signed), options);
    expect(parsed.signatures).toEqual([
      { algorithm: 'RSA256', keyName: 'equipe-6543.rsa.pub' },
      { algorithm: 'RSA', keyName: 'ancienne.rsa.pub' },
    ]);
    const unsigned = await apkFormat.parse(new BufferSource(buildApk()), options);
    expect(parsed.indexChecksum).toBe(unsigned.indexChecksum);
  });

  it('signale chaque script dans un ordre fixe', async () => {
    const scripts = { '.trigger': SCRIPT, '.pre-install': SCRIPT, '.post-upgrade': SCRIPT, '.pre-deinstall': SCRIPT };
    expect((await parse({ scripts })).maintainerScripts).toEqual([
      '.pre-install',
      '.pre-deinstall',
      '.post-upgrade',
      '.trigger',
    ]);
  });

  it('prend le paquet lui-même comme source quand origin est absent', async () => {
    expect(await parse(withLine('origin', undefined))).toMatchObject({ sourceName: 'hello', sourceVersion: '2.10-r3' });
  });

  it.each<[string, ApkSpec]>([
    ['pkgname absent', withLine('pkgname', undefined)],
    ['pkgver absent', withLine('pkgver', undefined)],
    ['arch absent', withLine('arch', undefined)],
    ['datahash absent', { datahash: null }],
    ['datahash faux', { datahash: '0'.repeat(64) }],
    ['datahash mal formé', { datahash: 'xyz' }],
    ['nom invalide', withLine('pkgname', 'hel lo')],
    ['version invalide', withLine('pkgver', '1.0bc')],
    ['architecture invalide', withLine('arch', 'x86-64')],
    ['taille non numérique', withLine('size', 'abc')],
    ['origine invalide', withLine('origin', 'hel lo')],
    ['dépendance invalide', withLine('depend', 'a>=')],
    ['fourniture invalide', withLine('provides', 'a>1')],
    ['remplacement avec version', withLine('replaces', 'a=1')],
    ['.PKGINFO absent', { controlEntries: [{ path: '.post-install', data: SCRIPT }] }],
    [
      'fichier de données dans le contrôle',
      {
        controlEntries: [
          { path: '.PKGINFO', data: 'x' },
          { path: 'usr/bin/x', data: 'y' },
        ],
      },
    ],
    ['entrée de contrôle inconnue', { scripts: { '.INSTALL': SCRIPT } }],
    ['chemin ./.PKGINFO', { controlEntries: [{ path: './.PKGINFO', data: 'pkgname = a\n' }] }],
    [
      'script en double',
      {
        controlEntries: [
          { path: '.PKGINFO', data: 'x' },
          { path: '.trigger', data: 'a' },
          { path: '.trigger', data: 'b' },
        ],
      },
    ],
    [
      'lien dans le contrôle',
      {
        controlEntries: [
          { path: '.PKGINFO', data: 'x' },
          { path: '.trigger', type: '2', linkTarget: '/bin/sh' },
        ],
      },
    ],
    ['signature dans le contrôle', { controlEntries: [{ path: '.PKGINFO', data: 'x' }, signatureEntry()] }],
    ['signature au type inconnu', { signature: [signatureEntry('ED25519')] }],
    ['signature au nom de clé avec /', { signature: [signatureEntry('RSA256', '../../etc/x')] }],
    ['signature de plus de 64 Kio', { signature: [signatureEntry('RSA256', 'k.rsa.pub', 65_537)] }],
  ])('refuse : %s (FORMAT_INVALID)', async (_label, spec) => {
    expect(await codeOf(spec)).toBe('FORMAT_INVALID');
  });

  it('refuse un paquet sans membre de données (FORMAT_TRUNCATED)', async () => {
    expect(await codeOf({ members: ({ control }) => [control] })).toBe('FORMAT_TRUNCATED');
  });

  it('vérifie datahash sur tout ce qui suit le contrôle, y compris plusieurs membres de données', async () => {
    const tar = buildTar([{ path: 'usr/bin/a', data: 'a' }]);
    const parts = [gzipSync(tar.subarray(0, 512)), gzipSync(tar.subarray(512))];
    const datahash = createHash('sha256').update(Buffer.concat(parts)).digest('hex');
    const bytes = buildApk({ datahash, members: ({ control }) => [control, ...parts] });
    expect((await apkFormat.parse(new BufferSource(bytes), options)).name).toBe('hello');
  });

  it('refuse un membre gzip de contrôle corrompu (FORMAT_CORRUPT_STREAM)', async () => {
    const bytes = Buffer.from(buildApk());
    bytes[20] = (bytes[20] ?? 0) ^ 0xff;
    expect(['FORMAT_CORRUPT_STREAM', 'FORMAT_INVALID']).toContain(await codeOf(bytes));
  });
});

describe('apkInnerStreams (SEC-01)', () => {
  it('rend le contrôle puis les données décompressés', async () => {
    const apk = buildApk({ scripts: { '.post-install': SCRIPT }, signature: [signatureEntry()] });
    const seen: [string, string][] = [];
    for await (const stream of apkFormat.innerStreams(new BufferSource(apk), options)) {
      const parts: Uint8Array[] = [];
      for await (const chunk of stream.data) parts.push(chunk);
      seen.push([stream.name, Buffer.concat(parts).toString('latin1')]);
    }
    expect(seen.map(([name]) => name)).toEqual(['control.tar', 'data.tar']);
    expect(seen[0]?.[1]).toContain('MARQUEUR-SEC01');
    expect(seen[1]?.[1]).toContain('echo bonjour');
  });

  it("refuse des octets après le dernier membre de données : couverts par datahash, ils échapperaient à l'analyse", async () => {
    const tail = Buffer.from('CONTENU-HORS-GZIP');
    const dataWithTail = (data: Uint8Array) => Buffer.concat([data, tail]);
    const apk = buildApk({
      members: ({ control, data }) => [control, dataWithTail(data)],
      datahash: createHash('sha256')
        .update(dataWithTail(gzipSync(buildTar(DEFAULT_DATA))))
        .digest('hex'),
    });
    let code = 'aucune erreur';
    try {
      for await (const stream of apkFormat.innerStreams(new BufferSource(apk), options)) {
        for await (const _chunk of stream.data);
      }
    } catch (error) {
      code = (error as { code?: string }).code ?? String(error);
    }
    expect(code).toBe('FORMAT_CORRUPT_STREAM');
  });
});
