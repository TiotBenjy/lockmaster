import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { seal, unseal } from '../crypto/seal.js';
import { LockmasterError } from '../domain/errors.js';
import { runTransaction } from '../system/sqlite-tx.js';
import {
  type KeyIdentity,
  type KeyRecord,
  type KeyState,
  type KeyStore,
  type NewKey,
  type RepoFormat,
  validateNewKey,
} from './keystore.js';

// KeyStore du signataire dans signer.db (table `key`, docs/05) : la clé privée est scellée par la clé
// maîtresse du SIGNATAIRE et n'est déchiffrée qu'à la demande, en mémoire. L'AAD lie le chiffré à sa
// ligne ET à tout ce qui ne doit pas changer (type, usage, empreinte, clé publique, identité) : une
// identité modifiée directement dans la base rend la clé indéchiffrable (fail closed) ; seule la CLI
// locale, qui détient la clé maîtresse, pourrait la sceller à nouveau.

interface KeyRow {
  id: string;
  kind: KeyRecord['kind'];
  purpose: KeyRecord['purpose'];
  fingerprint: string;
  public_key: string;
  repo_name: string | null;
  repo_format: string | null;
  origin_label: string | null;
  allowed_names: string;
  state: KeyState;
  created_at: number;
  expires_at: number | null;
}

const SELECT_ONE = `SELECT id, kind, purpose, fingerprint, public_key, repo_name, repo_format, origin_label,
  allowed_names, state, created_at, expires_at FROM key WHERE id = ?`;
const SELECT_ALL = `SELECT id, kind, purpose, fingerprint, public_key, repo_name, repo_format, origin_label,
  allowed_names, state, created_at, expires_at FROM key ORDER BY created_at, id`;
const INSERT = `INSERT INTO key (id, kind, purpose, fingerprint, public_key, repo_name, repo_format, origin_label,
  allowed_names, state, created_at, expires_at, private_key_enc)
  VALUES (@id, @kind, @purpose, @fingerprint, @publicKey, @repoName, @repoFormat, @originLabel, @allowedNames,
  @state, @createdAt, @expiresAt, @privateKeyEnc)`;

const notFound = () => new LockmasterError('KEY_NOT_FOUND', 'clé inconnue');
const conflict = () => new LockmasterError('KEY_STATE_CONFLICT', 'état de clé inattendu');

/** Contexte de scellement : identifiant de la ligne et empreinte de tout ce qui est immuable. */
function sealContext(record: KeyRecord) {
  const immutable = [
    record.kind,
    record.purpose,
    record.fingerprint,
    createHash('sha256').update(record.publicKey, 'utf8').digest('hex'),
    record.identity?.repoName ?? null,
    record.identity?.repoFormat ?? null,
    record.identity?.originLabel ?? null,
    record.identity?.allowedNames ?? [],
  ];
  const digest = createHash('sha256').update(JSON.stringify(immutable), 'utf8').digest('hex');
  return { table: 'key', column: 'private_key_enc', id: `${record.id}:${digest}` };
}

function identityOf(row: KeyRow): KeyIdentity | null {
  if (row.repo_name === null) return null;
  return {
    repoName: row.repo_name,
    repoFormat: row.repo_format as RepoFormat,
    originLabel: row.origin_label ?? '',
    allowedNames: JSON.parse(row.allowed_names) as string[],
  };
}

const toRecord = (row: KeyRow): KeyRecord => ({
  id: row.id,
  kind: row.kind,
  purpose: row.purpose,
  fingerprint: row.fingerprint,
  publicKey: row.public_key,
  identity: identityOf(row),
  state: row.state,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

export class SqliteKeyStore implements KeyStore {
  readonly #db: Database.Database;
  readonly #masterKey: Buffer;

  constructor(db: Database.Database, masterKey: Buffer) {
    this.#db = db;
    this.#masterKey = masterKey;
  }

  insert(key: NewKey): void {
    validateNewKey(key);
    const { privateKey, ...record } = key;
    runTransaction(this.#db, () => {
      const exists = this.#db.prepare('SELECT 1 FROM key WHERE id = ? OR fingerprint = ?').get(key.id, key.fingerprint);
      if (exists) throw new LockmasterError('KEY_EXISTS', 'clé déjà présente');
      this.#db.prepare(INSERT).run({
        id: key.id,
        kind: key.kind,
        purpose: key.purpose,
        fingerprint: key.fingerprint,
        publicKey: key.publicKey,
        repoName: key.identity?.repoName ?? null,
        repoFormat: key.identity?.repoFormat ?? null,
        originLabel: key.identity?.originLabel ?? null,
        allowedNames: JSON.stringify(key.identity?.allowedNames ?? []),
        state: key.state,
        createdAt: key.createdAt,
        expiresAt: key.expiresAt,
        privateKeyEnc: seal(this.#masterKey, Buffer.from(privateKey, 'utf8'), sealContext(record)),
      });
    });
  }

  get(id: string): KeyRecord | undefined {
    const row = this.#db.prepare(SELECT_ONE).get(id) as KeyRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(): KeyRecord[] {
    return (this.#db.prepare(SELECT_ALL).all() as KeyRow[]).map(toRecord);
  }

  privateKey(id: string): string {
    const record = this.get(id);
    if (!record) throw notFound();
    if (record.state === 'retired') throw new LockmasterError('KEY_RETIRED', 'clé retirée');
    const row = this.#db.prepare('SELECT private_key_enc FROM key WHERE id = ?').get(id) as { private_key_enc: Buffer };
    return unseal(this.#masterKey, row.private_key_enc, sealContext(record)).toString('utf8');
  }

  /** Compare et écrit : l'état observé doit être attendu et toujours le même au moment de l'écriture. */
  transition(id: string, from: readonly KeyState[], to: KeyState): void {
    const current = this.get(id);
    if (!current) throw notFound();
    if (current.state === 'retired' || !from.includes(current.state)) throw conflict();
    const result = this.#db.prepare('UPDATE key SET state = ? WHERE id = ? AND state = ?').run(to, id, current.state);
    if (result.changes !== 1) throw conflict();
  }
}
