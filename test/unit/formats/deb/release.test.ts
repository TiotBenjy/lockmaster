import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FormatError } from '../../../../src/formats/common/errors.js';
import { formatReleaseDate, parseRelease } from '../../../../src/formats/deb/release.js';

// Fichier Release d'un dépôt APT (docs/03 §2.4) : uniquement les champs que Lockmaster génère, sommes de
// contrôle bien formées, dates au format RFC 2822 en UTC. Sert au signataire (contrôle apt-release,
// ADR-0009) et à la vérification des index amont.

const SHA256 = 'a'.repeat(64);
const RELEASE = [
  'Origin: lockmaster-debian-12',
  'Label: lockmaster-debian-12 stable',
  'Suite: stable',
  'Codename: bookworm',
  'Date: Sun, 22 Nov 2026 10:00:00 UTC',
  'Valid-Until: Sun, 29 Nov 2026 10:00:00 UTC',
  'Architectures: amd64 arm64',
  'Components: main',
  'Acquire-By-Hash: yes',
  'MD5Sum:',
  ` ${'b'.repeat(32)} 1234 main/binary-amd64/Packages`,
  'SHA256:',
  ` ${SHA256} 1234 main/binary-amd64/Packages`,
  ` ${'c'.repeat(64)} 567 main/binary-amd64/Packages.gz`,
  '',
].join('\n');

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof FormatError ? error.code : String(error);
  }
  return undefined;
}

describe('parseRelease', () => {
  it('lit les champs, les dates et les sommes de contrôle', () => {
    const release = parseRelease(RELEASE);
    expect(release).toMatchObject({
      origin: 'lockmaster-debian-12',
      label: 'lockmaster-debian-12 stable',
      suite: 'stable',
      date: new Date('2026-11-22T10:00:00Z'),
      validUntil: new Date('2026-11-29T10:00:00Z'),
    });
    expect(release.checksums.SHA256).toEqual([
      { hash: SHA256, size: 1234, path: 'main/binary-amd64/Packages' },
      { hash: 'c'.repeat(64), size: 567, path: 'main/binary-amd64/Packages.gz' },
    ]);
    expect(release.checksums.MD5Sum).toHaveLength(1);
    expect(release.checksums.SHA512).toEqual([]);
  });

  it("formate une date comme apt la lit, et la relit à l'identique", () => {
    const date = new Date('2026-11-22T10:00:00Z');
    expect(formatReleaseDate(date)).toBe('Sun, 22 Nov 2026 10:00:00 UTC');
  });

  const replace = (from: string, to: string) => RELEASE.replace(from, to);
  it.each([
    ['champ inconnu', `${RELEASE}Evil: 1\n`],
    ['champ en double', `Origin: x\n${RELEASE}`],
    ['Origin absent', replace('Origin: lockmaster-debian-12\n', '')],
    ['Valid-Until absent', replace('Valid-Until: Sun, 29 Nov 2026 10:00:00 UTC\n', '')],
    ['SHA256 absent', RELEASE.slice(0, RELEASE.indexOf('SHA256:'))],
    ['date sans UTC', replace('Sun, 22 Nov 2026 10:00:00 UTC', 'Sun, 22 Nov 2026 10:00:00 +0000')],
    ['jour de semaine faux', replace('Sun, 22 Nov 2026', 'Mon, 22 Nov 2026')],
    ['date impossible', replace('Sun, 22 Nov 2026', 'Sun, 31 Nov 2026')],
    ['somme de mauvaise longueur', replace(` ${SHA256} 1234`, ` ${SHA256}0 1234`)],
    ['somme en majuscules', replace(` ${SHA256} 1234`, ` ${SHA256.toUpperCase()} 1234`)],
    ['chemin qui remonte', replace('main/binary-amd64/Packages.gz', '../../etc/passwd')],
    ['chemin absolu', replace('main/binary-amd64/Packages.gz', '/etc/passwd')],
    ['taille non numérique', replace('567 main', '5x7 main')],
    [
      'ligne de somme incomplète',
      replace(` ${'c'.repeat(64)} 567 main/binary-amd64/Packages.gz`, ` ${'c'.repeat(64)} 567`),
    ],
    ['valeur sur plusieurs lignes', replace('Suite: stable', 'Suite: stable\n continuation')],
    ['Acquire-By-Hash autre que yes', replace('Acquire-By-Hash: yes', 'Acquire-By-Hash: no')],
    ['caractère de contrôle', replace('Suite: stable', 'Suite: sta\u0007ble')],
    ['fins de ligne CRLF', RELEASE.replaceAll('\n', '\r\n')],
    ['second paragraphe', `${RELEASE}\nOrigin: autre\n`],
    ['Suite absent', replace('Suite: stable\n', '')],
    ['Label absent', replace('Label: lockmaster-debian-12 stable\n', '')],
    ['Date absent', replace('Date: Sun, 22 Nov 2026 10:00:00 UTC\n', '')],
    ['tabulation dans une ligne de somme', replace(` ${SHA256} 1234`, ` ${SHA256}\t1234`)],
    ['blanc après le chemin', replace('Packages.gz', 'Packages.gz ')],
    ['segment « . »', replace('main/binary-amd64/Packages.gz', 'main/./Packages.gz')],
    ['chemin en double', replace('main/binary-amd64/Packages.gz', 'main/binary-amd64/Packages')],
  ])('refuse : %s', (_label, text) => {
    expect(codeOf(() => parseRelease(text))).toBe('FORMAT_INVALID');
  });

  it('une entrée quelconque lève au plus une FormatError (propriété)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (text) => {
        try {
          parseRelease(text);
        } catch (error) {
          expect(error).toBeInstanceOf(FormatError);
        }
      }),
    );
  });
});
