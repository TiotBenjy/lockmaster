import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { seal, unseal } from '../../../src/crypto/seal.js';
import { LockmasterError } from '../../../src/domain/errors.js';

const KEY = randomBytes(32);
const CONTEXT = { table: 'account', column: 'totp_secret_enc', id: '01JABCDEF' };
const SECRET = Buffer.from('secret TOTP de 20 o.');

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof LockmasterError ? error.code : String(error);
  }
  return undefined;
}

describe('seal / unseal (AES-256-GCM, docs/02 §3.3)', () => {
  it('rend le clair après un aller-retour, avec un nonce différent à chaque chiffrement', () => {
    const a = seal(KEY, SECRET, CONTEXT);
    const b = seal(KEY, SECRET, CONTEXT);
    expect(unseal(KEY, a, CONTEXT)).toEqual(SECRET);
    expect(a.equals(b)).toBe(false);
    expect(a.subarray(1, 13).equals(b.subarray(1, 13))).toBe(false);
    // version (1) + nonce (12) + chiffré + étiquette (16)
    expect(a.length).toBe(1 + 12 + SECRET.length + 16);
    expect(a.includes(SECRET)).toBe(false);
  });

  it('chiffre aussi un contenu vide', () => {
    expect(unseal(KEY, seal(KEY, Buffer.alloc(0), CONTEXT), CONTEXT)).toEqual(Buffer.alloc(0));
  });

  it('refuse un chiffré déplacé vers une autre ligne, colonne ou table (AAD)', () => {
    const sealed = seal(KEY, SECRET, CONTEXT);
    for (const other of [
      { ...CONTEXT, id: '01JOTHER' },
      { ...CONTEXT, column: 'secret_enc' },
      { ...CONTEXT, table: 'repo_credential' },
    ]) {
      expect(
        codeOf(() => unseal(KEY, sealed, other)),
        JSON.stringify(other),
      ).toBe('CRYPTO_UNSEAL_FAILED');
    }
  });

  it('refuse une mauvaise clé, un chiffré altéré, tronqué ou de version inconnue, avec le même code', () => {
    const sealed = seal(KEY, SECRET, CONTEXT);
    const flipped = (index: number) => {
      const copy = Buffer.from(sealed);
      copy[index] = (copy[index] ?? 0) ^ 1;
      return copy;
    };
    for (const [label, key, data] of [
      ['mauvaise clé', randomBytes(32), sealed],
      ['nonce altéré', KEY, flipped(5)],
      ['chiffré altéré', KEY, flipped(14)],
      ['étiquette altérée', KEY, flipped(sealed.length - 1)],
      ['version inconnue', KEY, flipped(0)],
      ['tronqué', KEY, sealed.subarray(0, 20)],
      ['vide', KEY, Buffer.alloc(0)],
    ] as const) {
      expect(
        codeOf(() => unseal(key, data, CONTEXT)),
        label,
      ).toBe('CRYPTO_UNSEAL_FAILED');
    }
  });

  it('refuse une clé qui ne fait pas 32 octets et un contexte incomplet ou ambigu', () => {
    expect(codeOf(() => seal(randomBytes(16), SECRET, CONTEXT))).toBe('CRYPTO_KEY_INVALID');
    expect(codeOf(() => unseal(randomBytes(31), seal(KEY, SECRET, CONTEXT), CONTEXT))).toBe('CRYPTO_KEY_INVALID');
    for (const context of [
      { ...CONTEXT, id: '' },
      { ...CONTEXT, table: 'a.b' },
      { ...CONTEXT, column: 'x\0y' },
    ]) {
      expect(
        codeOf(() => seal(KEY, SECRET, context)),
        JSON.stringify(context),
      ).toBe('CRYPTO_CONTEXT_INVALID');
    }
  });
});
