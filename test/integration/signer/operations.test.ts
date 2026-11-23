import { generateKeyPairSync, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apkKeyFingerprint } from '../../../src/crypto/apk-rsa.js';
import { generateOpenPgpKey, type OpenPgpKeyType } from '../../../src/crypto/openpgp.js';
import { createIdGenerator } from '../../../src/domain/id.js';
import type { GenerateKeyRequest } from '../../../src/domain/signer-protocol.js';
import { SignatureJournal } from '../../../src/signer/journal.js';
import { SqliteKeyStore } from '../../../src/signer/keystore-sqlite.js';
import { migrateSignerDatabase } from '../../../src/signer/migrations.js';
import { type KeyGenerators, SignerOperations } from '../../../src/signer/operations.js';
import { runTransaction } from '../../../src/system/sqlite-tx.js';
import { FakeRandom } from '../../fakes/random.js';

// Opérations de gestion des clés du signataire (ADR-0009) : génération, rotation, retrait, état et
// journal. Générateurs rapides injectés (Ed25519, RSA 2048) ; la production utilise RSA 4096.

const NOW = new Date('2026-11-22T10:00:00Z');
const clock = { now: () => NOW };
const identity = {
  repoName: 'debian-12',
  repoFormat: 'deb' as const,
  originLabel: 'lockmaster-debian-12',
  allowedNames: ['*'],
};
const repoKey: GenerateKeyRequest = { op: 'generate-key', purpose: 'repo', kind: 'openpgp', identity };

let db: Database.Database;
let journal: SignatureJournal;
let operations: SignerOperations;
let openpgpTypes: OpenPgpKeyType[];

const generators: KeyGenerators = {
  async openpgp({ name, type, date }) {
    openpgpTypes.push(type);
    const key = await generateOpenPgpKey({ name, type: 'ed25519', date, validityDays: 730 });
    return { ...key, expiresAt: date.getTime() + 730 * 86_400_000 };
  },
  async apk() {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    return {
      publicKey: publicKeyPem,
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      fingerprint: apkKeyFingerprint(publicKeyPem),
      expiresAt: null,
    };
  },
};

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('recursive_triggers = ON');
  migrateSignerDatabase(db, 0);
  journal = new SignatureJournal(db);
  openpgpTypes = [];
  operations = new SignerOperations({
    keys: new SqliteKeyStore(db, randomBytes(32)),
    journal,
    clock,
    newId: createIdGenerator(clock, new FakeRandom('operations')),
    atomic: (fn) => runTransaction(db, fn),
    generators,
  });
});
afterEach(() => db.close());

async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return 'aucune erreur';
  } catch (error) {
    return (error as { code?: string }).code ?? `erreur sans code : ${(error as Error).message}`;
  }
}

describe('génération de clés', () => {
  it('clé de dépôt OpenPGP active, RSA 4096 par défaut, certificat de révocation rendu et jamais stocké', async () => {
    const { key, revocationCertificate } = await operations.generateKey(repoKey);
    expect(key).toMatchObject({
      kind: 'openpgp',
      purpose: 'repo',
      state: 'active',
      identity,
      createdAt: NOW.getTime(),
    });
    expect(openpgpTypes).toEqual(['rsa4096']);
    expect(revocationCertificate).toContain('-----BEGIN PGP PUBLIC KEY BLOCK-----');
    const dump =
      JSON.stringify(db.prepare('SELECT * FROM key').all()) +
      JSON.stringify(db.prepare('SELECT * FROM signature_log').all());
    const body = (revocationCertificate ?? '').split('\n').find((line) => line.length >= 40);
    expect(body).toBeDefined();
    expect(dump).not.toContain(body);
    expect(JSON.stringify(key)).not.toContain('PRIVATE');
  });

  it("journalise la génération (key-generate, done) avec l'horloge du signataire", async () => {
    const { key } = await operations.generateKey(repoKey);
    const [entry] = journal.list({ afterSeq: 0, limit: 10 });
    expect(entry).toMatchObject({ kind: 'key-generate', outcome: 'done', keyId: key.id, at: NOW.getTime() });
    expect(entry?.request).toMatchObject({ purpose: 'repo', kind: 'openpgp', repo: 'debian-12' });
  });

  it('Ed25519 seulement pour un dépôt APT (deb)', async () => {
    await operations.generateKey({ ...repoKey, algorithm: 'ed25519' });
    expect(openpgpTypes).toEqual(['ed25519']);
    const rpm = {
      ...repoKey,
      algorithm: 'ed25519' as const,
      identity: { ...identity, repoName: 'rocky-9', repoFormat: 'rpm' as const },
    };
    expect(await codeOf(() => operations.generateKey(rpm))).toBe('SIGNER_REQUEST_INVALID');
    const apk = {
      op: 'generate-key' as const,
      purpose: 'repo' as const,
      kind: 'apk-rsa' as const,
      algorithm: 'rsa4096' as const,
      identity: { ...identity, repoFormat: 'apk' as const },
    };
    expect(await codeOf(() => operations.generateKey(apk))).toBe('SIGNER_REQUEST_INVALID');
  });

  it('clé APK : empreinte SHA-256, sans expiration ni certificat de révocation', async () => {
    const { key, revocationCertificate } = await operations.generateKey({
      op: 'generate-key',
      purpose: 'repo',
      kind: 'apk-rsa',
      identity: { ...identity, repoName: 'alpine-3', repoFormat: 'apk' },
    });
    expect(key.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(key.expiresAt).toBeNull();
    expect(revocationCertificate).toBeUndefined();
  });

  it("une seule clé non retirée par dépôt et par type ; une seule clé d'audit", async () => {
    await operations.generateKey(repoKey);
    expect(await codeOf(() => operations.generateKey(repoKey))).toBe('KEY_EXISTS');
    await operations.generateKey({ op: 'generate-key', purpose: 'audit' });
    expect(await codeOf(() => operations.generateKey({ op: 'generate-key', purpose: 'audit' }))).toBe('KEY_EXISTS');
    expect(operations.listKeys().keys).toHaveLength(2);
  });

  it('refuse une identité invalide (KEY_INVALID), sans rien écrire', async () => {
    const bad = { ...repoKey, identity: { ...identity, originLabel: 'a\nb' } };
    expect(await codeOf(() => operations.generateKey(bad))).toBe('KEY_INVALID');
    expect(operations.listKeys().keys).toEqual([]);
    expect(journal.verify()).toEqual({ ok: true, count: 0, head: null });
  });
});

describe('rotation et retrait', () => {
  it('rotation : nouvelle clé rotating_in (même identité, même type), ancienne rotating_out, journalisée', async () => {
    const { key: old } = await operations.generateKey({ ...repoKey, algorithm: 'ed25519' });
    const { key: fresh, revocationCertificate } = await operations.rotateKey(old.id);
    expect(fresh).toMatchObject({ state: 'rotating_in', identity, kind: 'openpgp', purpose: 'repo' });
    expect(fresh.id).not.toBe(old.id);
    expect(revocationCertificate).toBeDefined();
    expect(openpgpTypes).toEqual(['ed25519', 'ed25519']);
    expect(operations.listKeys().keys.find((key) => key.id === old.id)?.state).toBe('rotating_out');
    expect(journal.list({ afterSeq: 0, limit: 10 }).at(-1)).toMatchObject({
      kind: 'key-rotate',
      keyId: fresh.id,
      request: { previousKeyId: old.id },
    });
  });

  it("retrait de l'ancienne clé : la nouvelle devient active", async () => {
    const { key: old } = await operations.generateKey(repoKey);
    const { key: fresh } = await operations.rotateKey(old.id);
    const result = operations.retireKey(old.id);
    expect(result.key.state).toBe('retired');
    const states = Object.fromEntries(operations.listKeys().keys.map((key) => [key.id, key.state]));
    expect(states).toEqual({ [old.id]: 'retired', [fresh.id]: 'active' });
    expect(journal.list({ afterSeq: 0, limit: 10 }).at(-1)).toMatchObject({
      kind: 'key-retire',
      keyId: old.id,
      request: { promotedKeyId: fresh.id },
    });
  });

  it("retrait de la nouvelle clé (rotation abandonnée) : l'ancienne redevient active", async () => {
    const { key: old } = await operations.generateKey(repoKey);
    const { key: fresh } = await operations.rotateKey(old.id);
    operations.retireKey(fresh.id);
    expect(operations.listKeys().keys.find((key) => key.id === old.id)?.state).toBe('active');
  });

  it("refuse la rotation d'une clé inconnue, non active ou retirée, et le retrait d'une clé retirée", async () => {
    expect(await codeOf(() => operations.rotateKey('inconnue'))).toBe('KEY_NOT_FOUND');
    const { key: old } = await operations.generateKey(repoKey);
    await operations.rotateKey(old.id);
    expect(await codeOf(() => operations.rotateKey(old.id))).toBe('KEY_STATE_CONFLICT');
    operations.retireKey(old.id);
    expect(await codeOf(() => operations.rotateKey(old.id))).toBe('KEY_STATE_CONFLICT');
    expect(await codeOf(async () => operations.retireKey(old.id))).toBe('KEY_STATE_CONFLICT');
    expect(await codeOf(async () => operations.retireKey('inconnue'))).toBe('KEY_NOT_FOUND');
  });

  it("refuse la rotation d'une clé dont l'identité a été modifiée en base : rien n'est créé", async () => {
    const { key } = await operations.generateKey(repoKey);
    db.prepare(`UPDATE key SET allowed_names = '["*", "openssl"]' WHERE id = ?`).run(key.id);
    expect(await codeOf(() => operations.rotateKey(key.id))).toBe('CRYPTO_UNSEAL_FAILED');
    expect(operations.listKeys().keys.map((record) => record.state)).toEqual(['active']);
    expect(openpgpTypes).toEqual(['rsa4096']);
  });

  it("refuse de réactiver une clé partenaire dont l'identité a été modifiée en base", async () => {
    const { key: old } = await operations.generateKey(repoKey);
    const { key: fresh } = await operations.rotateKey(old.id);
    db.prepare(`UPDATE key SET origin_label = 'autre' WHERE id = ?`).run(old.id);
    expect(await codeOf(async () => operations.retireKey(fresh.id))).toBe('CRYPTO_UNSEAL_FAILED');
    expect(operations.listKeys().keys.find((record) => record.id === fresh.id)?.state).toBe('rotating_in');
  });
});

describe('contrôles avant la génération coûteuse', () => {
  it("identité invalide ou clé en double : aucun matériel de clé n'est généré", async () => {
    const bad = { ...repoKey, identity: { ...identity, repoName: '../x' } };
    expect(await codeOf(() => operations.generateKey(bad))).toBe('KEY_INVALID');
    expect(openpgpTypes).toEqual([]);
    await operations.generateKey(repoKey);
    expect(await codeOf(() => operations.generateKey(repoKey))).toBe('KEY_EXISTS');
    expect(openpgpTypes).toEqual(['rsa4096']);
  });

  it('au plus 512 clés non retirées, rotation comprise ; les clés retirées ne comptent pas', async () => {
    let counter = 0;
    const limited = new SignerOperations({
      keys: new SqliteKeyStore(db, randomBytes(32)),
      journal,
      clock,
      newId: createIdGenerator(clock, new FakeRandom('limite')),
      atomic: (fn) => runTransaction(db, fn),
      generators: {
        openpgp: async () => {
          counter += 1;
          return {
            privateKey: 'k',
            publicKey: `pub-${counter}`,
            fingerprint: counter.toString(16).padStart(40, '0'),
            expiresAt: null,
          };
        },
        apk: () => Promise.reject(new Error('inutilisé')),
      },
    });
    const ids: string[] = [];
    for (let index = 0; index < 512; index += 1) {
      ids.push(
        (await limited.generateKey({ ...repoKey, identity: { ...identity, repoName: `depot-${index}` } })).key.id,
      );
    }
    const extra = { ...repoKey, identity: { ...identity, repoName: 'de-trop' } };
    expect(await codeOf(() => limited.generateKey(extra))).toBe('SIGNER_KEY_LIMIT');
    expect(await codeOf(() => limited.rotateKey(ids[0] ?? ''))).toBe('SIGNER_KEY_LIMIT');
    limited.retireKey(ids[0] ?? '');
    await limited.generateKey(extra);
    expect(limited.listKeys({ includeRetired: false }).keys).toHaveLength(512);
    expect(limited.listKeys().keys).toHaveLength(513);
  });
});

describe('état et journal', () => {
  it('compte les clés par état et rend la tête du journal', async () => {
    expect(operations.status()).toEqual({
      keys: { active: 0, rotating_in: 0, rotating_out: 0, retired: 0 },
      journalHead: null,
    });
    const { key } = await operations.generateKey(repoKey);
    await operations.rotateKey(key.id);
    const status = operations.status();
    expect(status.keys).toEqual({ active: 0, rotating_in: 1, rotating_out: 1, retired: 0 });
    expect(status.journalHead).toEqual(
      journal.verify().ok ? { seq: 2, hash: expect.stringMatching(/^[0-9a-f]{64}$/) } : null,
    );
  });

  it('rend le journal par tranches avec sa tête', async () => {
    await operations.generateKey(repoKey);
    await operations.generateKey({ op: 'generate-key', purpose: 'audit' });
    const page = operations.log({ afterSeq: 1, limit: 10 });
    expect(page.entries.map((entry) => entry.seq)).toEqual([2]);
    expect(page.head?.seq).toBe(2);
  });
});
