// Structure d'un en-tête RPM : mêmes contrôles que hdrblobVerifyLengths, hdrblobVerifyRegion et
// hdrblobVerifyInfo de rpm 4.19 (lib/header.c), chacun vérifié par un en-tête forgé.
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../../../../src/formats/common/limits.js';
import { parseRpmHeader } from '../../../../src/formats/rpm/header.js';
import { buildHeader, type HeaderOptions, type RpmTag, TYPE } from '../../../fixtures/builders/rpm.js';

const TAGS: RpmTag[] = [
  { tag: 1000, type: TYPE.STRING, value: 'hello' },
  { tag: 1003, type: TYPE.INT32, value: 7 },
  { tag: 1030, type: TYPE.INT16, value: [0o100755, 0o40755] },
  { tag: 1047, type: TYPE.STRING_ARRAY, value: ['a', 'b(c)'] },
  { tag: 1005, type: TYPE.I18N, value: ['texte'] },
  { tag: 5009, type: TYPE.INT64, value: 5_000_000_000n },
  { tag: 1012, type: TYPE.BIN, value: Uint8Array.of(1, 2, 3) },
];

const parse = (bytes: Uint8Array, kind: 'signature' | 'main' = 'main') => parseRpmHeader(bytes, kind, DEFAULT_LIMITS);

function codeOf(bytes: Uint8Array, kind: 'signature' | 'main' = 'main'): string {
  try {
    parse(bytes, kind);
    return 'aucune erreur';
  } catch (error) {
    return (error as { code?: string }).code ?? `erreur sans code : ${String(error)}`;
  }
}

const header = (options: HeaderOptions = {}, tags: RpmTag[] = TAGS, region = 63) => buildHeader(tags, region, options);

describe('parseRpmHeader', () => {
  it('lit chaque type de valeur et la taille totale', () => {
    const bytes = header();
    const parsed = parse(Buffer.concat([bytes, Buffer.from('payload')]));
    expect(parsed.byteLength).toBe(bytes.length);
    expect(parsed.string(1000)).toBe('hello');
    expect(parsed.uint32(1003)).toEqual([7]);
    expect(parsed.uint16(1030)).toEqual([0o100755, 0o40755]);
    expect(parsed.strings(1047)).toEqual(['a', 'b(c)']);
    expect(parsed.string(1005)).toBe('texte');
    expect(parsed.uint64(5009)).toEqual([5_000_000_000]);
    expect(parsed.has(1012)).toBe(true);
    expect(parsed.string(9999)).toBeUndefined();
    expect(parsed.strings(9999)).toEqual([]);
  });

  it('lit un en-tête de signature (région 62, ou 61 dans le trailer des anciens paquets)', () => {
    const sig: RpmTag[] = [{ tag: 1000, type: TYPE.INT32, value: 42 }];
    expect(parse(buildHeader(sig, 62), 'signature').uint32(1000)).toEqual([42]);
    expect(parse(buildHeader(sig, 62, { trailer: { tag: 61 } }), 'signature').uint32(1000)).toEqual([42]);
  });

  it.each<[string, Uint8Array]>([
    ['magie fausse', header({ magic: Uint8Array.of(0x8e, 0xad, 0xe8, 0x02, 0, 0, 0, 0) })],
    ['octets réservés non nuls', header({ magic: Uint8Array.of(0x8e, 0xad, 0xe8, 0x01, 0, 0, 0, 1) })],
    ['tag de région faux', header({ region: { tag: 62 } })],
    ['type de région faux', header({ region: { type: TYPE.INT32 } })],
    ['nombre de la région faux', header({ region: { count: 15 } })],
    ['trailer au tag faux', header({ trailer: { tag: 62 } })],
    ['trailer non multiple de 16', header({ trailer: { offset: -(16 * 8) + 4 } })],
    ["région plus courte que l'en-tête", header({ trailer: { offset: -(16 * 7) } })],
    ["région plus longue que l'en-tête", header({ trailer: { offset: -(16 * 9) } })],
    ['région hors des données', header({ patchIndex: [[0, 'offset', 100_000]] })],
    ['tag inférieur à 100', header({ patchIndex: [[1, 'tag', 99]] })],
    ['type nul', header({ patchIndex: [[1, 'type', 0]] })],
    ['type inconnu', header({ patchIndex: [[1, 'type', 10]] })],
    ['nombre nul', header({ patchIndex: [[1, 'count', 0]] })],
    ['nombre plus grand que les données', header({ patchIndex: [[3, 'count', 1_000_000]] })],
    ['entier mal aligné', header({ patchIndex: [[2, 'offset', 9]] })],
    ['décalage négatif', header({ patchIndex: [[1, 'offset', -4]] })],
    ['décalage au-delà des données', header({ patchIndex: [[7, 'offset', 100_000]] })],
    ['entrées qui se chevauchent', header({ patchIndex: [[2, 'offset', 0]] })],
    ['chaîne sans octet nul final', header({}, [{ tag: 1000, type: TYPE.STRING, value: Buffer.from('abc') }])],
    ['chaîne avec plusieurs éléments', header({}, [{ tag: 1000, type: TYPE.STRING, value: 'abc', count: 2 }])],
    ['tableau plus long que ses chaînes', header({}, [{ tag: 1047, type: TYPE.STRING_ARRAY, value: ['a'], count: 2 }])],
    ['tableau de plus de 0xfffff éléments', header({}, [{ tag: 1012, type: TYPE.INT8, value: [1], count: 0x100000 }])],
    ['tag connu au mauvais type', header({}, [{ tag: 1000, type: TYPE.INT32, value: 1 }])],
    [
      'tag en double',
      header({}, [
        { tag: 1000, type: TYPE.STRING, value: 'a' },
        { tag: 1000, type: TYPE.STRING, value: 'b' },
      ]),
    ],
    ['UTF-8 invalide', header({}, [{ tag: 1000, type: TYPE.STRING, value: Uint8Array.of(0xff, 0), count: 1 }])],
    ['entiers au-delà des données', header({}, [{ tag: 1003, type: TYPE.INT32, value: [1], count: 20 }])],
    [
      'tableau de plus de 0xfffff éléments dans de grandes données',
      header({}, [
        { tag: 1012, type: TYPE.BIN, value: new Uint8Array(0x100010) },
        { tag: 1013, type: TYPE.INT8, value: [1], count: 0x100000 },
      ]),
    ],
  ])('refuse : %s (FORMAT_INVALID)', (_label, bytes) => {
    expect(codeOf(bytes)).toBe('FORMAT_INVALID');
  });

  it('admet une chaîne simple là où rpm attend un tableau (interpréteur sans argument, build/parseScript.c)', () => {
    const parsed = parse(header({}, [{ tag: 1086, type: TYPE.STRING, value: '/bin/sh' }]));
    expect(parsed.strings(1086)).toEqual(['/bin/sh']);
  });

  it("admet un tag répété à l'identique (SOURCERPM écrit deux fois par rpmbuild 4.19.1.1 de Rocky 10)", () => {
    const parsed = parse(
      header({}, [
        { tag: 1044, type: TYPE.STRING, value: 'demo-1-1.src.rpm' },
        { tag: 1044, type: TYPE.STRING, value: 'demo-1-1.src.rpm' },
      ]),
    );
    expect(parsed.string(1044)).toBe('demo-1-1.src.rpm');
  });

  it.each([
    [
      'tag répété avec une autre valeur',
      [
        { tag: 1044, type: TYPE.STRING, value: 'a-1-1.src.rpm' },
        { tag: 1044, type: TYPE.STRING, value: 'b-1-1.src.rpm' },
      ],
    ],
    [
      'tag répété avec un autre type',
      [
        { tag: 1047, type: TYPE.STRING_ARRAY, value: ['a'] },
        { tag: 1047, type: TYPE.STRING, value: 'a' },
      ],
    ],
  ] as const)('refuse : %s (FORMAT_INVALID)', (_label, tags) => {
    expect(codeOf(header({}, [...tags]))).toBe('FORMAT_INVALID');
  });

  it.each([
    ['tableau là où rpm attend une chaîne', { tag: 1000, type: TYPE.STRING_ARRAY, value: ['a', 'b'] }],
    ['chaîne traduite là où rpm attend un tableau', { tag: 1086, type: TYPE.I18N, value: ['/bin/sh'] }],
  ] as const)('refuse : %s (FORMAT_INVALID)', (_label, tag) => {
    expect(codeOf(header({}, [tag]))).toBe('FORMAT_INVALID');
  });

  it('refuse des données qui empiètent sur le trailer de région', () => {
    const bytes = Buffer.from(header({}, [{ tag: 1003, type: TYPE.INT32, value: 7 }]));
    // Entrée 1 (EPOCH, 4 octets en 0) : déplacée au début du trailer, en 4, sans sortir des données.
    bytes.writeInt32BE(4, 16 + 16 + 8);
    expect(() => parse(bytes)).toThrowError(/trailer de région/);
  });

  it('refuse un en-tête tronqué (FORMAT_TRUNCATED)', () => {
    const bytes = header();
    expect(codeOf(bytes.subarray(0, 10))).toBe('FORMAT_TRUNCATED');
    expect(codeOf(bytes.subarray(0, bytes.length - 1))).toBe('FORMAT_TRUNCATED');
  });

  it('refuse un en-tête sans entrée et applique les bornes de rpm et de limits.ts (FORMAT_LIMIT_EXCEEDED)', () => {
    const empty = Buffer.from(header());
    empty.writeUInt32BE(0, 8);
    expect(codeOf(empty)).toBe('FORMAT_INVALID');
    const many = Array.from({ length: 33 }, (_, index): RpmTag => ({ tag: 1000 + index, type: TYPE.INT32, value: 1 }));
    expect(codeOf(buildHeader(many, 62), 'signature')).toBe('FORMAT_LIMIT_EXCEEDED');
    const huge = Buffer.from(header());
    huge.writeUInt32BE(DEFAULT_LIMITS.rpmMaxStoreBytes + 1, 12);
    expect(codeOf(huge)).toBe('FORMAT_LIMIT_EXCEEDED');
    const entries = Buffer.from(header());
    entries.writeUInt32BE(DEFAULT_LIMITS.rpmMaxIndexEntries + 1, 8);
    expect(codeOf(entries)).toBe('FORMAT_LIMIT_EXCEEDED');
  });
});
