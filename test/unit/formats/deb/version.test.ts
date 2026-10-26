import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareDebVersion, parseDebVersion } from '../../../../src/formats/deb/version.js';

const VECTORS = readFileSync(join(import.meta.dirname, '../../../fixtures/upstream/dpkg/version.data'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => line.split(' ') as [string, string, string]);

describe('compareDebVersion (vecteurs de dpkg)', () => {
  it('contient les 43 vecteurs', () => {
    expect(VECTORS).toHaveLength(43);
  });

  it.each(VECTORS)('%s comparé à %s : %s', (a, b, expected) => {
    expect(Math.sign(compareDebVersion(a, b))).toBe(Number(expected));
    expect(Math.sign(compareDebVersion(b, a))).toBe(-Number(expected) || 0);
  });

  it('trie comme dpkg (tri de Dpkg_Version.t)', () => {
    const input = ['4:4-4', '5.0abc', '0.0-0.0alpha0', '10.100.1-1', '0~999.999zeta', '0:1.0-0'];
    expect([...input].sort(compareDebVersion)).toEqual([
      '0~999.999zeta',
      '0.0-0.0alpha0',
      '0:1.0-0',
      '5.0abc',
      '10.100.1-1',
      '4:4-4',
    ]);
  });

  it('ordonne ~ avant la fin, la fin avant les lettres, les lettres avant les autres signes', () => {
    const sorted = ['1.0', '1.0~~', '1.0~~a', '1.0~', '1.0a', '1.0+'].sort(compareDebVersion);
    expect(sorted).toEqual(['1.0~~', '1.0~~a', '1.0~', '1.0', '1.0a', '1.0+']);
  });
});

describe('parseDebVersion', () => {
  it.each([
    ['1.0', { epoch: 0, upstream: '1.0', revision: '' }],
    ['0:1.0-1', { epoch: 0, upstream: '1.0', revision: '1' }],
    ['2:1.0-1.0-1', { epoch: 2, upstream: '1.0-1.0', revision: '1' }],
    ['1:1.0:1.0', { epoch: 1, upstream: '1.0:1.0', revision: '' }],
    ['0:0:0-0', { epoch: 0, upstream: '0:0', revision: '0' }],
    ['0:09azAZ.-+~:-0', { epoch: 0, upstream: '09azAZ.-+~:', revision: '0' }],
    ['0:0-azAZ09.+~', { epoch: 0, upstream: '0', revision: 'azAZ09.+~' }],
    ['2147483647:1', { epoch: 2_147_483_647, upstream: '1', revision: '' }],
  ])('découpe %s', (input, expected) => {
    expect(parseDebVersion(input)).toEqual(expected);
  });

  it.each([
    '',
    '-0',
    '0:-0',
    ':1.0',
    '1.0-',
    '10a:5.2',
    '5.2@3-2',
    'foo5.2',
    '0:foo5.2',
    '0:',
    '0:0 0-1',
    '-1:0-1',
    '999999999999999999999999:0-1',
    '2147483648:1',
    'a:0-0',
    '1.0:1',
    '0:0-0:0',
    '0:0a_b-0',
    '0:0-a_b',
    ' 1.0',
    '1.0\n',
  ])('refuse « %s » (FORMAT_INVALID)', (input) => {
    expect(() => parseDebVersion(input)).toThrowError(expect.objectContaining({ code: 'FORMAT_INVALID' }));
  });

  it('refuse de comparer une version invalide (FORMAT_INVALID)', () => {
    expect(() => compareDebVersion('1.0', 'x@y')).toThrowError(expect.objectContaining({ code: 'FORMAT_INVALID' }));
  });
});
