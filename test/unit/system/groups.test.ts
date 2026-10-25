import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveGroup } from '../../../src/system/groups.js';

const dir = mkdtempSync(join(tmpdir(), 'lockmaster-groups-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const groupFile = join(dir, 'group');
writeFileSync(
  groupFile,
  [
    'root:x:0:',
    'lockmaster-sign:x:10100:lockmaster',
    'lockmaster-sign:x:20200:',
    'sans-gid:x::',
    'crlf:x:30300\r',
    '+nis:::',
    '',
  ].join('\n'),
);

describe('resolveGroup', () => {
  it('rend un numéro tel quel, sans lire le fichier', () => {
    expect(resolveGroup('0', join(dir, 'absent'))).toBe(0);
    expect(resolveGroup('10100', join(dir, 'absent'))).toBe(10100);
  });

  it('cherche un nom dans le fichier ; la première ligne gagne (comme la glibc)', () => {
    expect(resolveGroup('root', groupFile)).toBe(0);
    expect(resolveGroup('lockmaster-sign', groupFile)).toBe(10100);
  });

  it.each([
    ['nom absent', 'inconnu'],
    ['ligne sans numéro', 'sans-gid'],
    ['numéro à zéro initial (traité comme un nom)', '0123'],
    ['entrée NIS', '+nis'],
    ['ligne terminée par CR (numéro illisible)', 'crlf'],
  ])('refuse : %s', (_label, spec) => {
    expect(() => resolveGroup(spec, groupFile)).toThrow(expect.objectContaining({ code: 'ACCOUNT_MISSING' }));
  });
});
