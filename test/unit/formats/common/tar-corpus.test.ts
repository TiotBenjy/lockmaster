// Lecture différentielle : archives écrites par GNU tar (test/fixtures/corpus-generate.ts), dont la
// liste attendue est celle que donne `tar -tv` sur les mêmes fichiers.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTar } from '../../../../src/formats/common/tar.js';

const ROOT = join(import.meta.dirname, '../../../fixtures/corpus/tar');
const LONG_DIR = `./${'d'.repeat(60)}/${'e'.repeat(60)}`;
const OPTIONS = { maxEntries: 100, maxEntryBytes: 1024, maxExtendedHeaderBytes: 4096, requireEndMarker: true };

const listing = (file: string): string[] =>
  parseTar(readFileSync(join(ROOT, file)), OPTIONS).map(
    (entry) =>
      `${entry.type} ${entry.mode.toString(8)} ${entry.size} ${entry.path}${entry.linkTarget ? ` -> ${entry.linkTarget}` : ''}`,
  );

const COMMON = [
  'file 644 17 ./control',
  `directory 755 0 ./${'d'.repeat(60)}/`,
  `directory 755 0 ${LONG_DIR}/`,
  `file 644 8 ${LONG_DIR}/fichier`,
  'symlink 777 0 ./lien -> control',
];

describe('archives GNU tar de référence', () => {
  it.each(['gnu.tar', 'pax.tar'])('%s : noms et cibles longs lus comme GNU tar', (file) => {
    expect(listing(file)).toEqual([
      'directory 755 0 ./',
      ...COMMON,
      `symlink 777 0 ./lien-long -> ${LONG_DIR.slice(2)}/fichier`,
      'file 755 17 ./postinst',
    ]);
  });

  it('ustar.tar : chemin long réparti entre préfixe et nom', () => {
    expect(listing('ustar.tar')).toEqual([...COMMON, 'file 755 17 ./postinst']);
  });
});
