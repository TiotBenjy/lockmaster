import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LockmasterError } from '../../../src/domain/errors.js';
import { assertPublishedPath, assertSha256, blobRelativePath, debPoolPath } from '../../../src/storage/paths.js';

const SHA = 'ab'.repeat(32);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof LockmasterError ? error.code : String(error);
  }
  return undefined;
}

describe('assertSha256 et blobRelativePath', () => {
  it('range un blob sous sha256/<2>/<2>/<sha256>', () => {
    const sha = `0f1e${'2d'.repeat(30)}`;
    expect(blobRelativePath(sha)).toBe(`sha256/0f/1e/${sha}`);
  });

  it("refuse tout identifiant qui n'est pas 64 caractères hexadécimaux en minuscules", () => {
    for (const id of [SHA.toUpperCase(), SHA.slice(1), `${SHA}a`, `../${SHA.slice(3)}`, `${SHA.slice(1)}\0`, '']) {
      expect(
        codeOf(() => assertSha256(id)),
        id,
      ).toBe('BLOB_INVALID_ID');
      expect(
        codeOf(() => blobRelativePath(id)),
        id,
      ).toBe('BLOB_INVALID_ID');
    }
    expect(assertSha256(SHA)).toBe(SHA);
  });
});

describe('assertPublishedPath', () => {
  it('accepte les chemins relatifs des arborescences publiées', () => {
    for (const path of [
      'pool/main/o/openssl/openssl_3.0.11-1_amd64.deb',
      'pool/main/libs/libssl3/libssl3_3.0.11-1~deb12u2+b1_amd64.deb',
      'dists/stable/_gen/000043/InRelease',
      'Packages/k/kernel-5.14.0-427.el9.x86_64.rpm',
      'main/x86_64/musl-1.2.5-r0.apk',
    ]) {
      expect(assertPublishedPath(path)).toBe(path);
    }
  });

  it.each([
    ['vide', ''],
    ['absolu', '/etc/passwd'],
    ['remontée', 'pool/../../etc/passwd'],
    ['segment courant', 'pool/./main'],
    ['segment vide', 'pool//main'],
    ['barre finale', 'pool/main/'],
    ['fichier caché', 'pool/.htaccess'],
    ['octet nul', 'pool/a\0b.deb'],
    ['barre oblique inverse', 'pool\\main'],
    ['espace', 'pool/a b.deb'],
    ['deux-points', 'pool/main/o/openssl/openssl_1:3.0_amd64.deb'],
    ['non ASCII', 'pool/café.deb'],
    ['saut de ligne', 'pool/a\nb.deb'],
    ['segment de plus de 255 octets', `pool/${'a'.repeat(256)}`],
    ['chemin de plus de 1024 octets', Array.from({ length: 10 }, () => 'a'.repeat(110)).join('/')],
    ['plus de 16 segments', Array.from({ length: 17 }, () => 'a').join('/')],
  ])('refuse un chemin %s', (_label, path) => {
    expect(codeOf(() => assertPublishedPath(path))).toBe('PUBLISHED_PATH_INVALID');
  });

  it('tout chemin accepté reste relatif et sans remontée (propriété)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (path) => {
        let accepted: string | undefined;
        try {
          accepted = assertPublishedPath(path);
        } catch (error) {
          expect(error).toBeInstanceOf(LockmasterError);
          return;
        }
        expect(accepted.startsWith('/')).toBe(false);
        expect(accepted.split('/')).not.toContain('..');
        expect(accepted.split('/')).not.toContain('.');
        expect(accepted).not.toContain('\0');
      }),
    );
  });
});

describe('debPoolPath (docs/03 §2.2)', () => {
  const base = { component: 'main', name: 'openssl', source: 'openssl', version: '3.0.11-1', arch: 'amd64' };

  it('construit pool/<composant>/<préfixe>/<source>/<nom>_<version sans epoch>_<arch>.deb', () => {
    expect(debPoolPath(base)).toBe('pool/main/o/openssl/openssl_3.0.11-1_amd64.deb');
    expect(debPoolPath({ ...base, version: '1:3.0.11-1' })).toBe('pool/main/o/openssl/openssl_3.0.11-1_amd64.deb');
  });

  it('préfixe libX pour les paquets source lib*, première lettre sinon', () => {
    expect(debPoolPath({ ...base, name: 'libssl3', source: 'openssl' })).toBe(
      'pool/main/o/openssl/libssl3_3.0.11-1_amd64.deb',
    );
    expect(debPoolPath({ ...base, name: 'libc6', source: 'glibc' })).toBe('pool/main/g/glibc/libc6_3.0.11-1_amd64.deb');
    expect(debPoolPath({ ...base, name: 'libfoo1', source: 'libfoo' })).toBe(
      'pool/main/libf/libfoo/libfoo1_3.0.11-1_amd64.deb',
    );
    expect(debPoolPath({ ...base, name: 'lib', source: 'lib' })).toBe('pool/main/l/lib/lib_3.0.11-1_amd64.deb');
  });

  it.each([
    ['nom avec remontée', { name: '../x' }],
    ['source avec barre', { source: 'a/b' }],
    ['composant avec remontée', { component: '..' }],
    ['version avec deux-points hors epoch', { version: '1:2:3' }],
    ['version avec barre', { version: '1.0/../../x' }],
    ['architecture vide', { arch: '' }],
    ['nom commençant par un point', { name: '.hidden' }],
    ['« _ » dans le nom (séparateur du fichier)', { name: 'a_b' }],
    ['« _ » dans la version', { version: '1.0_2' }],
    ["« _ » dans l'architecture", { arch: 'x86_64' }],
  ])('refuse un champ dangereux : %s', (_label, change) => {
    expect(codeOf(() => debPoolPath({ ...base, ...change }))).toBe('PUBLISHED_PATH_INVALID');
  });

  it('le chemin se redécoupe exactement en ses champs : aucune collision possible (propriété)', () => {
    // Les champs peuvent contenir « _ » : debPoolPath doit alors refuser, sinon le découpage serait ambigu.
    const field = fc.stringMatching(/^[a-z0-9][a-z0-9._+~-]{0,8}$/);
    const epoch = fc.option(fc.integer({ min: 0, max: 99 }), { nil: undefined });
    const entry = fc.record({ component: field, source: field, name: field, version: field, arch: field, epoch });
    fc.assert(
      fc.property(entry, ({ epoch: value, ...fields }) => {
        const input = { ...fields, version: value === undefined ? fields.version : `${value}:${fields.version}` };
        let path: string;
        try {
          path = debPoolPath(input);
        } catch (error) {
          expect((error as LockmasterError).code).toBe('PUBLISHED_PATH_INVALID');
          return;
        }
        const segments = path.split('/');
        expect(segments.slice(0, 2)).toEqual(['pool', fields.component]);
        expect(segments[3]).toBe(fields.source);
        const file = segments[4] ?? '';
        expect(file.endsWith('.deb')).toBe(true);
        expect(file.slice(0, -'.deb'.length).split('_')).toEqual([fields.name, fields.version, fields.arch]);
      }),
    );
  });
});
