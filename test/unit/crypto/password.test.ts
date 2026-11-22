import { describe, expect, it } from 'vitest';
import { PasswordHasher } from '../../../src/crypto/password.js';

// Paramètres réduits pour la vitesse des tests ; un test vérifie ceux de production (docs/02 §3.3).
const FAST = { N: 2 ** 10, r: 8, p: 1 };
const POOL = { threadPoolSize: 16 };

describe('PasswordHasher (scrypt, docs/02 §3.3)', () => {
  it('paramètres de production : N=2^17, r=8, p=1, sel 16 o, sortie 64 o, format scrypt$N$r$p$sel$hash', async () => {
    const hasher = new PasswordHasher(POOL);
    const stored = await hasher.hash('correct horse battery staple');
    const [scheme, n, r, p, salt, hash] = stored.split('$');
    expect([scheme, n, r, p]).toEqual(['scrypt', '131072', '8', '1']);
    expect(Buffer.from(salt ?? '', 'base64')).toHaveLength(16);
    expect(Buffer.from(hash ?? '', 'base64')).toHaveLength(64);
    expect(await hasher.verify('correct horse battery staple', stored)).toEqual({ valid: true, needsRehash: false });
  }, 20_000);

  it('vérifie le bon mot de passe, refuse un autre ; deux hachages du même mot de passe diffèrent (sel)', async () => {
    const hasher = new PasswordHasher({ ...POOL, params: FAST });
    const stored = await hasher.hash('mot de passe');
    expect(await hasher.verify('mot de passe', stored)).toEqual({ valid: true, needsRehash: false });
    expect((await hasher.verify('mot de passe ', stored)).valid).toBe(false);
    expect((await hasher.verify('', stored)).valid).toBe(false);
    expect(await hasher.hash('mot de passe')).not.toBe(stored);
  });

  it('normalise en NFKC : deux écritures Unicode équivalentes sont le même mot de passe', async () => {
    const hasher = new PasswordHasher({ ...POOL, params: FAST });
    const stored = await hasher.hash('café');
    expect((await hasher.verify('café', stored)).valid).toBe(true);
  });

  it('signale le re-hachage quand les paramètres ont changé', async () => {
    const stored = await new PasswordHasher({ ...POOL, params: FAST }).hash('secret');
    const stronger = new PasswordHasher({ ...POOL, params: { N: 2 ** 11, r: 8, p: 1 } });
    expect(await stronger.verify('secret', stored)).toEqual({ valid: true, needsRehash: true });
  });

  it('borne la longueur brute avant la normalisation (expansion NFKC), au hachage comme à la vérification', async () => {
    const hasher = new PasswordHasher({ ...POOL, params: FAST });
    const stored = await hasher.hash('secret');
    await expect(hasher.hash('')).rejects.toMatchObject({ code: 'PASSWORD_INVALID' });
    await expect(hasher.hash('x'.repeat(1025))).rejects.toMatchObject({ code: 'PASSWORD_INVALID' });
    await expect(hasher.hash('ﷺ'.repeat(1025))).rejects.toMatchObject({ code: 'PASSWORD_INVALID' });
    expect(await hasher.verify('ﷺ'.repeat(100_000), stored)).toEqual({ valid: false, needsRehash: false });
  });

  it('refuse une empreinte stockée mal formée ou au coût hors bornes (fail closed)', async () => {
    const hasher = new PasswordHasher({ ...POOL, params: FAST });
    const salt = Buffer.alloc(16).toString('base64');
    const hash = Buffer.alloc(64).toString('base64');
    for (const stored of [
      '',
      'bcrypt$2b$10$abc',
      `scrypt$1024$8$1$${salt}`,
      `scrypt$1000$8$1$${salt}$${hash}`,
      `scrypt$${2 ** 25}$8$1$${salt}$${hash}`,
      // coût CPU N*r*p hors de [moitié, double] des paramètres courants
      `scrypt$1024$8$16$${salt}$${hash}`,
      `scrypt$1024$1$1$${salt}$${hash}`,
      `scrypt$4096$8$1$${salt}$${hash}`,
      `scrypt$1024$8$1$${Buffer.alloc(4).toString('base64')}$${hash}`,
      `scrypt$1024$8$1$${salt}$${Buffer.alloc(16).toString('base64')}`,
    ]) {
      await expect(hasher.verify('x', stored), stored).rejects.toMatchObject({ code: 'PASSWORD_HASH_INVALID' });
    }
  });

  it('refuse une concurrence qui ne laisse pas au moins 2 fils libres dans le pool de libuv', () => {
    expect(() => new PasswordHasher({ threadPoolSize: 4 })).toThrow(
      expect.objectContaining({ code: 'PASSWORD_PARAMS_INVALID' }),
    );
    expect(() => new PasswordHasher({ threadPoolSize: 6 })).not.toThrow();
    expect(() => new PasswordHasher({ threadPoolSize: 3, concurrency: 1 })).not.toThrow();
    for (const threadPoolSize of [Number.NaN, Number.POSITIVE_INFINITY, 0, 2.5, -8]) {
      expect(() => new PasswordHasher({ threadPoolSize }), String(threadPoolSize)).toThrow(
        expect.objectContaining({ code: 'PASSWORD_PARAMS_INVALID' }),
      );
    }
  });

  it('au plus `concurrency` calculs simultanés ; au-delà de la file, refus immédiat (PASSWORD_HASHER_BUSY)', async () => {
    const hasher = new PasswordHasher({ ...POOL, params: FAST, concurrency: 2, maxQueue: 3 });
    const results = await Promise.allSettled(Array.from({ length: 7 }, () => hasher.hash('secret')));
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
    expect(rejected).toHaveLength(2);
    for (const result of rejected) expect(result.reason).toMatchObject({ code: 'PASSWORD_HASHER_BUSY' });
    // La file se vide : de nouveaux calculs passent.
    await expect(hasher.hash('secret')).resolves.toMatch(/^scrypt\$/);
  });

  it('une attente annulée quitte la file sans occuper de place', async () => {
    const hasher = new PasswordHasher({ ...POOL, params: FAST, concurrency: 1, maxQueue: 1 });
    const controller = new AbortController();
    const running = hasher.hash('a');
    const waiting = hasher.hash('b', controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'PASSWORD_ABORTED' });
    // La place libérée dans la file sert à une autre demande.
    const next = hasher.hash('c');
    await expect(Promise.all([running, next])).resolves.toHaveLength(2);
    await expect(hasher.hash('d', AbortSignal.abort())).rejects.toMatchObject({ code: 'PASSWORD_ABORTED' });
  });

  it('verifyDummy calcule un hachage complet et rend toujours faux (temps égalisé)', async () => {
    const hasher = new PasswordHasher({ ...POOL, params: FAST });
    expect(await hasher.verifyDummy('nimporte')).toEqual({ valid: false, needsRehash: false });
  });
});
