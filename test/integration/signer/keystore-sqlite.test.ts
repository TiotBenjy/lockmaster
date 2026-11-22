import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteKeyStore } from '../../../src/signer/keystore-sqlite.js';
import { migrateSignerDatabase } from '../../../src/signer/migrations.js';
import { describeKeyStoreContract } from '../../contracts/keystore.contract.js';

const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function database(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateSignerDatabase(db, 0);
  databases.push(db);
  return db;
}

describeKeyStoreContract(() => new SqliteKeyStore(database(), randomBytes(32)));

const KEY = {
  id: 'k1',
  kind: 'apk-rsa' as const,
  purpose: 'repo' as const,
  fingerprint: 'f'.repeat(40),
  publicKey: '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----\n',
  privateKey: '-----BEGIN PRIVATE KEY-----\nSECRET-MATERIAL\n-----END PRIVATE KEY-----\n',
  identity: { repoName: 'alpine-3', repoFormat: 'apk' as const, originLabel: 'lockmaster-alpine-3', allowedNames: [] },
  state: 'active' as const,
  createdAt: 0,
  expiresAt: null,
};

describe('SqliteKeyStore : chiffrement au repos', () => {
  it("la clé privée n'apparaît jamais en clair dans la base", () => {
    const db = database();
    new SqliteKeyStore(db, randomBytes(32)).insert(KEY);
    const row = db.prepare('SELECT private_key_enc FROM key').get() as { private_key_enc: Buffer };
    expect(row.private_key_enc.includes(Buffer.from('SECRET-MATERIAL'))).toBe(false);
    const dump = JSON.stringify(db.prepare('SELECT * FROM key').all());
    expect(dump).not.toContain('SECRET-MATERIAL');
  });

  it('ne se déchiffre ni avec une autre clé maîtresse, ni recopiée sur une autre ligne', () => {
    const db = database();
    const master = randomBytes(32);
    const store = new SqliteKeyStore(db, master);
    store.insert(KEY);
    store.insert({ ...KEY, id: 'k2', fingerprint: 'e'.repeat(40) });
    expect(() => new SqliteKeyStore(db, randomBytes(32)).privateKey('k1')).toThrow(
      expect.objectContaining({ code: 'CRYPTO_UNSEAL_FAILED' }),
    );
    db.prepare(
      "UPDATE key SET private_key_enc = (SELECT private_key_enc FROM key WHERE id = 'k1') WHERE id = 'k2'",
    ).run();
    expect(() => store.privateKey('k2')).toThrow(expect.objectContaining({ code: 'CRYPTO_UNSEAL_FAILED' }));
    expect(store.privateKey('k1')).toBe(KEY.privateKey);
  });

  it('une identité modifiée directement dans la base rend la clé indéchiffrable', () => {
    const db = database();
    const store = new SqliteKeyStore(db, randomBytes(32));
    store.insert(KEY);
    for (const sql of [
      `UPDATE key SET allowed_names = '["*"]'`,
      "UPDATE key SET origin_label = 'autre-depot'",
      "UPDATE key SET repo_name = 'autre-depot'",
      "UPDATE key SET public_key = 'autre'",
    ]) {
      const before = db.prepare('SELECT * FROM key').get();
      db.prepare(sql).run();
      expect(() => store.privateKey('k1'), sql).toThrow(expect.objectContaining({ code: 'CRYPTO_UNSEAL_FAILED' }));
      db.prepare('DELETE FROM key').run();
      const row = before as Record<string, unknown>;
      db.prepare(
        `INSERT INTO key (id, kind, purpose, fingerprint, public_key, private_key_enc, repo_name, repo_format,
         origin_label, allowed_names, state, created_at, expires_at)
         VALUES (@id, @kind, @purpose, @fingerprint, @public_key, @private_key_enc, @repo_name, @repo_format,
         @origin_label, @allowed_names, @state, @created_at, @expires_at)`,
      ).run(row);
      expect(store.privateKey('k1')).toBe(KEY.privateKey);
    }
  });

  it('un chiffré tronqué ou de version altérée ne se déchiffre pas', () => {
    const db = database();
    const store = new SqliteKeyStore(db, randomBytes(32));
    store.insert(KEY);
    const { private_key_enc: sealed } = db.prepare('SELECT private_key_enc FROM key').get() as {
      private_key_enc: Buffer;
    };
    const altered = Buffer.from(sealed);
    altered[0] = 0x02;
    for (const value of [sealed.subarray(0, 20), altered]) {
      db.prepare('UPDATE key SET private_key_enc = ?').run(value);
      expect(() => store.privateKey('k1')).toThrow(expect.objectContaining({ code: 'CRYPTO_UNSEAL_FAILED' }));
    }
  });
});
