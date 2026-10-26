import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../../../../src/formats/common/limits.js';
import { type ControlField, parseControl, serializeControl } from '../../../../src/formats/deb/control.js';

const bytes = (text: string): Uint8Array => Buffer.from(text, 'utf8');
const parse = (text: string) => parseControl(bytes(text), DEFAULT_LIMITS);

function codeOf(text: string | Uint8Array): string {
  try {
    parseControl(typeof text === 'string' ? bytes(text) : text, DEFAULT_LIMITS);
    return 'aucune erreur';
  } catch (error) {
    return (error as { code?: string }).code ?? `erreur sans code : ${String(error)}`;
  }
}

const SAMPLE = [
  'Package: hello',
  'Version: 2.10-3',
  'Architecture: amd64',
  'Maintainer: Santiago Vila <sanvila@debian.org>',
  'Depends: libc6 (>= 2.34),',
  ' libfoo | libbar',
  'Description: example package',
  ' Long description.',
  ' .',
  ' Second paragraph.',
  '',
].join('\n');

describe('parseControl', () => {
  it('lit les champs, leur ordre et les lignes de continuation', () => {
    const stanza = parse(SAMPLE);
    expect(stanza.fields.map((field) => field.name)).toEqual([
      'Package',
      'Version',
      'Architecture',
      'Maintainer',
      'Depends',
      'Description',
    ]);
    expect(stanza.get('depends')).toBe('libc6 (>= 2.34),\n libfoo | libbar');
    expect(stanza.get('Description')).toBe('example package\n Long description.\n .\n Second paragraph.');
  });

  it('cherche les noms de champ sans tenir compte de la casse et tolère tabulations et absence de fin de ligne', () => {
    const stanza = parse('package:\thello  \nDescription: x\n\tsuite');
    expect(stanza.get('PACKAGE')).toBe('hello');
    expect(stanza.get('description')).toBe('x\n\tsuite');
    expect(stanza.get('absent')).toBeUndefined();
  });

  it('ignore les lignes vides en tête et en fin', () => {
    expect(parse('\n\nPackage: a\n\n\n').get('Package')).toBe('a');
  });

  it.each([
    ['champ en double (casse différente)', 'Package: a\npackage: b\n'],
    ['commentaire', '# commentaire\nPackage: a\n'],
    ['second paragraphe', 'Package: a\n\nPackage: b\n'],
    ['continuation sans champ', ' suite\nPackage: a\n'],
    ['continuation vide', 'Description: a\n \nPackage: b\n'],
    ['ligne sans deux-points', 'Package a\n'],
    ['nom vide', ': a\n'],
    ['nom commençant par un tiret', '-Package: a\n'],
    ['nom avec espace', 'Pack age: a\n'],
    ['retour chariot', 'Package: a\r\n'],
    ['octet nul', 'Package: a\0\n'],
    ['caractère de contrôle C1', 'Package: a\u0085\n'],
    ['caractère DEL', 'Package: a\u007f\n'],
    ['espace insécable après la valeur', 'Version: 1.0\u00a0\n'],
    ['espace insécable avant la valeur', 'Version: \u00a01.0\n'],
    ['ligne de blancs Unicode', 'Package: a\n\u2003\n'],
  ])('refuse : %s (FORMAT_INVALID)', (_label, text) => {
    expect(codeOf(text)).toBe('FORMAT_INVALID');
  });

  it('refuse un UTF-8 invalide (FORMAT_INVALID)', () => {
    expect(codeOf(Uint8Array.of(0x50, 0x3a, 0x20, 0xff, 0x0a))).toBe('FORMAT_INVALID');
  });

  it('refuse un texte ou un champ au-delà des limites (FORMAT_LIMIT_EXCEEDED)', () => {
    expect(codeOf(`Description: ${'x'.repeat(DEFAULT_LIMITS.maxControlTextBytes)}\n`)).toBe('FORMAT_LIMIT_EXCEEDED');
    const longField = `Description: a\n${' suite\n'.repeat(DEFAULT_LIMITS.maxFieldBytes / 7 + 1)}`;
    expect(codeOf(longField)).toBe('FORMAT_LIMIT_EXCEEDED');
  });
});

describe('serializeControl', () => {
  it('écrit les champs dans leur ordre, une ligne vide finale exclue', () => {
    const fields: ControlField[] = [
      { name: 'Package', value: 'hello' },
      { name: 'Description', value: 'synopsis\n Long.\n .\n Fin.' },
      { name: 'Empty', value: '' },
    ];
    expect(serializeControl(fields)).toBe('Package: hello\nDescription: synopsis\n Long.\n .\n Fin.\nEmpty:\n');
  });

  it.each<[string, ControlField]>([
    ["injection d'un champ par saut de ligne", { name: 'Description', value: 'x\nPackage: evil' }],
    ['ligne de continuation vide', { name: 'Description', value: 'x\n \n .' }],
    ['nom invalide', { name: 'Pack age', value: 'x' }],
    ['nom commençant par #', { name: '#Package', value: 'x' }],
    ['retour chariot', { name: 'Package', value: 'x\r' }],
    ['valeur à espace initial', { name: 'Package', value: ' x' }],
  ])('refuse : %s (FORMAT_INVALID)', (_label, field) => {
    expect(() => serializeControl([field])).toThrowError(expect.objectContaining({ code: 'FORMAT_INVALID' }));
  });

  it("relit exactement ce qu'il écrit (aller-retour)", () => {
    const name = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9-]{0,15}$/);
    const line = fc.stringMatching(/^[a-zA-Z0-9.]([a-zA-Z0-9.,()<>=|+~ ]{0,30}[a-zA-Z0-9.])?$/);
    const value = fc
      .tuple(fc.option(line, { nil: '' }), fc.array(line, { maxLength: 4 }))
      .map(([first, rest]) => [first, ...rest.map((text) => ` ${text}`)].join('\n'));
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.record({ name, value }), {
          selector: (f) => f.name.toLowerCase(),
          minLength: 1,
          maxLength: 8,
        }),
        (fields) => {
          expect(parse(serializeControl(fields)).fields).toEqual(fields);
        },
      ),
    );
  });
});
