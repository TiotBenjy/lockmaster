import { describe, expect, it } from 'vitest';
import { base32Encode, generateTotpSecret, totpCode, totpStep, verifyTotp } from '../../../src/crypto/totp.js';

// RFC 6238, annexe B : secret ASCII « 12345678901234567890 », SHA-1 ; codes à 8 chiffres réduits ici
// aux 6 derniers (même troncature dynamique, modulo 10^6).
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: Array<[number, string]> = [
  [59, '287082'],
  [1_111_111_109, '081804'],
  [1_111_111_111, '050471'],
  [1_234_567_890, '005924'],
  [2_000_000_000, '279037'],
  [20_000_000_000, '353130'],
];

const at = (seconds: number) => new Date(seconds * 1000);

describe('TOTP (RFC 6238, docs/02 §3.3)', () => {
  it.each(RFC_VECTORS)('vecteur RFC 6238 à t=%i : %s', (seconds, code) => {
    expect(totpCode(RFC_SECRET, totpStep(at(seconds)))).toBe(code);
  });

  it('accepte le pas courant et ses voisins immédiats, rend le pas utilisé', () => {
    const now = at(1_111_111_111);
    const step = totpStep(now);
    for (const offset of [-1, 0, 1]) {
      const code = totpCode(RFC_SECRET, step + offset);
      expect(verifyTotp({ secret: RFC_SECRET, code, now, lastStep: null })).toEqual({ ok: true, step: step + offset });
    }
    for (const offset of [-2, 2]) {
      const code = totpCode(RFC_SECRET, step + offset);
      expect(verifyTotp({ secret: RFC_SECRET, code, now, lastStep: null }).ok).toBe(false);
    }
  });

  it('anti-rejeu : refuse un code dont le pas a déjà servi, ou un pas antérieur', () => {
    const now = at(1_111_111_111);
    const step = totpStep(now);
    const code = totpCode(RFC_SECRET, step);
    expect(verifyTotp({ secret: RFC_SECRET, code, now, lastStep: step }).ok).toBe(false);
    expect(verifyTotp({ secret: RFC_SECRET, code, now, lastStep: step + 1 }).ok).toBe(false);
    const previous = totpCode(RFC_SECRET, step - 1);
    expect(verifyTotp({ secret: RFC_SECRET, code: previous, now, lastStep: step - 1 }).ok).toBe(false);
    expect(verifyTotp({ secret: RFC_SECRET, code, now, lastStep: step - 1 })).toEqual({ ok: true, step });
  });

  it('refuse un code mal formé', () => {
    const now = at(59);
    for (const code of ['', '28708', '2870820', '28708a', ' 287082', '287082\n', '２８７０８２']) {
      expect(verifyTotp({ secret: RFC_SECRET, code, now, lastStep: null }).ok, JSON.stringify(code)).toBe(false);
    }
    expect(verifyTotp({ secret: RFC_SECRET, code: '287082', now, lastStep: null }).ok).toBe(true);
  });

  it('secret de 20 octets aléatoires ; base32 RFC 4648 sans remplissage', () => {
    const secret = generateTotpSecret();
    expect(secret).toHaveLength(20);
    expect(generateTotpSecret().equals(secret)).toBe(false);
    expect(base32Encode(secret)).toMatch(/^[A-Z2-7]{32}$/);
    // RFC 4648 §10 : « f » -> MY, « foobar » -> MZXW6YTBOI (sans « = »)
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('refuse un secret qui ne fait pas 20 octets : une clé HMAC vide serait calculable par tous', () => {
    const now = at(59);
    for (const secret of [Buffer.alloc(0), Buffer.alloc(10), Buffer.alloc(32)]) {
      const check = { secret, code: '287082', now, lastStep: null };
      expect(() => verifyTotp(check), String(secret.length)).toThrow(
        expect.objectContaining({ code: 'TOTP_SECRET_INVALID' }),
      );
      expect(() => totpCode(secret, 1)).toThrow(expect.objectContaining({ code: 'TOTP_SECRET_INVALID' }));
    }
  });

  it('refuse un pas négatif, non entier ou une date invalide (erreur typée)', () => {
    for (const step of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => totpCode(RFC_SECRET, step), String(step)).toThrow(
        expect.objectContaining({ code: 'TOTP_STEP_INVALID' }),
      );
    }
    const check = { secret: RFC_SECRET, code: '287082', now: new Date(Number.NaN), lastStep: null };
    expect(() => verifyTotp(check)).toThrow(expect.objectContaining({ code: 'TOTP_STEP_INVALID' }));
  });

  it('accepte un code au tout premier pas (fenêtre bornée à 0)', () => {
    const code = totpCode(RFC_SECRET, 0);
    expect(verifyTotp({ secret: RFC_SECRET, code, now: at(10), lastStep: null })).toEqual({ ok: true, step: 0 });
  });
});
