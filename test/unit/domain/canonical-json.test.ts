import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../src/domain/canonical-json.js';

describe('canonicalJson', () => {
  it('trie les clés à tous les niveaux : même contenu, mêmes octets', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 0, y: null }], c: 'x' } }, 8)).toBe(
      '{"a":{"c":"x","d":[2,{"y":null,"z":0}]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 }, 8)).toBe(canonicalJson({ b: 2, a: 1 }, 8));
  });

  it.each([
    ['nombre non fini', { n: Number.NaN }],
    ['valeur undefined', { u: undefined }],
    ['fonction', { f: () => 1 }],
    ['objet non simple', { d: new Date(0) }],
  ])('refuse une valeur non JSON : %s', (_label, value) => {
    expect(() => canonicalJson(value, 8)).toThrow(expect.objectContaining({ code: 'CANONICAL_JSON_INVALID' }));
  });

  it('refuse au-delà de la profondeur maximale, sans dépassement de pile', () => {
    expect(canonicalJson({ a: { b: 1 } }, 2)).toBe('{"a":{"b":1}}');
    expect(() => canonicalJson({ a: { b: { c: 1 } } }, 2)).toThrow(
      expect.objectContaining({ code: 'CANONICAL_JSON_INVALID' }),
    );
    const deep = JSON.parse(`${'{"a":'.repeat(100_000)}1${'}'.repeat(100_000)}`);
    expect(() => canonicalJson(deep, 8)).toThrow(expect.objectContaining({ code: 'CANONICAL_JSON_INVALID' }));
  });
});
