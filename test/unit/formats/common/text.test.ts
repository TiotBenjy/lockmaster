import { describe, expect, it } from 'vitest';
import { hasForbiddenCharacter } from '../../../../src/formats/common/text.js';

describe('hasForbiddenCharacter', () => {
  it('accepte le texte ordinaire, y compris hors du plan de base', () => {
    expect(hasForbiddenCharacter('Programme de démonstration \u{1f600} \uFFFD')).toBe(false);
  });

  it.each(['\u0000', '\u0001', '\r', '\u001f', '\u007f', '\u0085', '\u009f', '\ufffe', '\uffff'])(
    'refuse U+%s',
    (character) => {
      expect(hasForbiddenCharacter(`a${character}b`)).toBe(true);
    },
  );

  it("n'admet saut de ligne et tabulation que si la règle les autorise", () => {
    expect(hasForbiddenCharacter('a\nb')).toBe(true);
    expect(hasForbiddenCharacter('a\tb')).toBe(true);
    expect(hasForbiddenCharacter('a\nb\tc', { newline: true, tab: true })).toBe(false);
    expect(hasForbiddenCharacter('a\nb', { tab: true })).toBe(true);
  });
});
