import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareRpmEvr, formatRpmEvr, parseRpmEvr, rpmvercmp } from '../../../../src/formats/rpm/version.js';

const VECTORS = readFileSync(join(import.meta.dirname, '../../../fixtures/upstream/rpm/rpmvercmp.data'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => line.split(' ') as [string, string, string]);

describe('rpmvercmp (vecteurs de rpm 4.19.1)', () => {
  it('contient les 91 vecteurs', () => {
    expect(VECTORS).toHaveLength(91);
  });

  it.each(VECTORS)('rpmvercmp(%s, %s) = %s', (a, b, expected) => {
    expect(rpmvercmp(a, b)).toBe(Number(expected));
  });
});

describe('EVR (epoch:version-release)', () => {
  it.each([
    ['1.0-1', { epoch: 0, version: '1.0', release: '1' }],
    ['2:1.0-1.el9', { epoch: 2, version: '1.0', release: '1.el9' }],
    ['0:1.0~rc1-0.1^git2', { epoch: 0, version: '1.0~rc1', release: '0.1^git2' }],
    ['1.0', { epoch: 0, version: '1.0', release: '' }],
  ])('découpe %s', (input, expected) => {
    expect(parseRpmEvr(input)).toEqual(expected);
  });

  it("écrit l'epoch seulement s'il est présent dans l'en-tête", () => {
    expect(formatRpmEvr({ epoch: undefined, version: '1.0', release: '1.el9' })).toBe('1.0-1.el9');
    expect(formatRpmEvr({ epoch: 0, version: '1.0', release: '1' })).toBe('0:1.0-1');
    expect(formatRpmEvr({ epoch: 3, version: '2', release: '4' })).toBe('3:2-4');
    expect(formatRpmEvr({ epoch: undefined, version: '1.0', release: '' })).toBe('1.0');
  });

  it('compare epoch (absent = 0), puis version, puis release', () => {
    expect(compareRpmEvr('1:1.0-1', '9.9-9')).toBeGreaterThan(0);
    expect(compareRpmEvr('0:1.0-1', '1.0-1')).toBe(0);
    expect(compareRpmEvr('1.0-2', '1.0-10')).toBeLessThan(0);
    expect(compareRpmEvr('1.0~rc1-1', '1.0-1')).toBeLessThan(0);
    expect(compareRpmEvr('1.0-1', '1.0')).toBeGreaterThan(0);
  });

  it.each(['', '-1', '1.0-', 'a:1.0-1', ':1.0-1', '1.0-1-2', '1 .0-1', '1.0-1\n', '4294967296:1-1', '1/0-1'])(
    'refuse « %s » (FORMAT_INVALID)',
    (input) => {
      expect(() => parseRpmEvr(input)).toThrowError(expect.objectContaining({ code: 'FORMAT_INVALID' }));
    },
  );
});
