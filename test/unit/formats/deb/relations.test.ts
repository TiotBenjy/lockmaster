import { describe, expect, it } from 'vitest';
import { parseDebRelations } from '../../../../src/formats/deb/relations.js';

const groups = { alternatives: true } as const;
const single = { alternatives: false } as const;

describe('parseDebRelations', () => {
  it('lit groupes, alternatives, opérateurs, qualificatifs et lignes repliées', () => {
    expect(parseDebRelations('libc6 (>= 2.34), libfoo:any | libbar (<< 2:1.0-1),\n python3:native', groups)).toEqual([
      [{ name: 'libc6', operator: 'ge', version: '2.34' }],
      [
        { name: 'libfoo', qualifier: 'any' },
        { name: 'libbar', operator: 'lt', version: '2:1.0-1' },
      ],
      [{ name: 'python3', qualifier: 'native' }],
    ]);
  });

  it.each([
    ['<<', 'lt'],
    ['<=', 'le'],
    ['=', 'eq'],
    ['>=', 'ge'],
    ['>>', 'gt'],
  ])('normalise %s en %s', (operator, normalized) => {
    expect(parseDebRelations(`a0 (${operator}1)`, groups)).toEqual([
      [{ name: 'a0', operator: normalized, version: '1' }],
    ]);
  });

  it('rend une liste vide pour un champ vide ou blanc', () => {
    expect(parseDebRelations('', groups)).toEqual([]);
    expect(parseDebRelations('  \n ', groups)).toEqual([]);
  });

  it.each([
    ['opérateur obsolète <', 'a0 (< 1)'],
    ['opérateur obsolète >', 'a0 (> 1)'],
    ['version invalide', 'a0 (>= 1@2)'],
    ['nom invalide', 'A0'],
    ['nom trop court', 'a'],
    ["restriction d'architecture (source seulement)", 'a0 [amd64]'],
    ['profil de construction (source seulement)', 'a0 <!nocheck>'],
    ['élément vide', 'a0,, b0'],
    ['virgule finale', 'a0,'],
    ['alternative vide', 'a0 |'],
    ['parenthèse non fermée', 'a0 (>= 1'],
    ['qualificatif invalide', 'a0:Any'],
  ])('refuse : %s (FORMAT_INVALID)', (_label, value) => {
    expect(() => parseDebRelations(value, groups)).toThrowError(expect.objectContaining({ code: 'FORMAT_INVALID' }));
  });

  it('refuse les alternatives dans un champ qui ne les admet pas', () => {
    expect(() => parseDebRelations('a0 | b0', single)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_INVALID' }),
    );
    expect(parseDebRelations('a0, b0', single)).toHaveLength(2);
  });

  it("n'admet que « = » dans Provides", () => {
    expect(parseDebRelations('a0 (= 1)', { alternatives: false, equalOnly: true })).toHaveLength(1);
    expect(() => parseDebRelations('a0 (>= 1)', { alternatives: false, equalOnly: true })).toThrowError(
      expect.objectContaining({ code: 'FORMAT_INVALID' }),
    );
  });
});
