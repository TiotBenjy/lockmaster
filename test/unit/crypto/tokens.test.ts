import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateApiToken, generateSecretToken, hashToken, tokenHashesEqual } from '../../../src/crypto/tokens.js';

describe('jetons (docs/02 §3.3)', () => {
  it('jeton secret : 32 octets aléatoires en base64url, stocké en SHA-256', () => {
    const { token, hash } = generateSecretToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(generateSecretToken().token).not.toBe(token);
  });

  it("jeton d'API : préfixe lkm_, partie visible courte, empreinte du jeton complet", () => {
    const { token, hash, prefix } = generateApiToken();
    expect(token).toMatch(/^lkm_[A-Za-z0-9_-]{43}$/);
    expect(prefix).toBe(token.slice(0, 12));
    expect(hash).toBe(hashToken(token));
  });

  it('compare deux empreintes en temps constant, sans accepter une empreinte mal formée', () => {
    const { hash } = generateSecretToken();
    expect(tokenHashesEqual(hash, hash)).toBe(true);
    expect(tokenHashesEqual(hash, generateSecretToken().hash)).toBe(false);
    expect(tokenHashesEqual(hash, hash.slice(1))).toBe(false);
    expect(tokenHashesEqual(hash.toUpperCase(), hash.toUpperCase())).toBe(false);
    expect(tokenHashesEqual('', '')).toBe(false);
  });
});
