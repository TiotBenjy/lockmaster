import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareApkVersion, isValidApkVersion } from '../../../../src/formats/apk/version.js';

const LINES = readFileSync(join(import.meta.dirname, '../../../fixtures/upstream/apk-tools/version.data'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => line.replace(/#.*$/, '').trim().split(/\s+/) as [string, string, string]);
const SIGN: Readonly<Record<string, number>> = { '<': -1, '=': 0, '>': 1 };
const VALID = LINES.filter(([a, , b]) => isValidApkVersion(a) && isValidApkVersion(b));

describe("compareApkVersion (vecteurs d'apk-tools 2.14)", () => {
  it('contient les 733 vecteurs, dont 2 à version invalide', () => {
    expect(LINES).toHaveLength(733);
    expect(LINES.length - VALID.length).toBe(2);
  });

  it.each(VALID)('%s %s %s', (a, op, b) => {
    expect(Math.sign(compareApkVersion(a, b))).toBe(SIGN[op]);
    expect(Math.sign(compareApkVersion(b, a))).toBe(-(SIGN[op] ?? 0) || 0);
  });

  it.each(['1.0bc', '23_foo', '', '1.0-', '1.0-r', '1.0_', 'a1', '1..2', '1.0-r1-r2', '1.0_alpha_', '1.0@', '1.0 '])(
    'refuse « %s » (FORMAT_INVALID)',
    (version) => {
      expect(isValidApkVersion(version)).toBe(false);
      expect(() => compareApkVersion(version, '1.0')).toThrowError(expect.objectContaining({ code: 'FORMAT_INVALID' }));
    },
  );

  it("admet les formes valides d'apk", () => {
    for (const version of [
      '1',
      '1.0',
      '1.0a',
      '1.0_alpha2',
      '1.0_p1_rc3',
      '1.0-r0',
      '20231231',
      '1.0_git20240101-r5',
    ]) {
      expect(isValidApkVersion(version)).toBe(true);
    }
  });
});
