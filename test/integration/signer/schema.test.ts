import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateSignerDatabase, SIGNER_MIGRATIONS } from '../../../src/signer/migrations.js';
import { REPO_ROOT } from '../../helpers/run-script.js';

// Schéma de la base du signataire (docs/05 §Base du service de signature, ADR-0009) : 0001_signer.sql
// reproduit exactement le document, et le journal de signatures est en ajout seul.

const NOW = 1_800_000_000_000;
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  migrateSignerDatabase(db, NOW);
});
afterEach(() => db.close());

function statements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((part) => part.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim())
    .filter((part) => part !== '');
}

function documentedSchema(): string {
  const doc = readFileSync(join(REPO_ROOT, 'docs/05-modele-de-donnees.md'), 'utf8');
  const start = doc.indexOf('```sql', doc.indexOf('## Base du service de signature'));
  return doc.slice(start + '```sql'.length, doc.indexOf('```', start + 1));
}

const insertKey = (id: string, purpose: string, repoName: string | null) =>
  db
    .prepare(
      `INSERT INTO key (id, kind, purpose, fingerprint, public_key, private_key_enc, repo_name, state, created_at)
       VALUES (?, 'openpgp', ?, ?, 'pub', x'00', ?, 'active', 0)`,
    )
    .run(id, purpose, `fpr-${id}`, repoName);

const GENESIS = '0'.repeat(64);
const insertLog = (
  seq: number,
  prevHash: string,
  options: { keyId?: string | null; outcome?: string; verb?: string } = {},
) =>
  db
    .prepare(
      `${options.verb ?? 'INSERT'} INTO signature_log (seq, at, key_id, kind, content_sha256, request, outcome, prev_hash, hash)
       VALUES (?, 0, ?, 'apt-release', 'c', '{}', ?, ?, ?)`,
    )
    .run(seq, options.keyId === undefined ? 'k1' : options.keyId, options.outcome ?? 'signed', prevHash, `h${seq}`);

describe('schéma de la base du signataire', () => {
  it('0001_signer.sql reproduit exactement docs/05', () => {
    expect(SIGNER_MIGRATIONS.map((migration) => migration.name)).toEqual(['signer']);
    expect(statements(SIGNER_MIGRATIONS[0]?.sql ?? '')).toEqual(statements(documentedSchema()));
  });

  it("une clé de dépôt porte un nom de dépôt, une clé d'audit non", () => {
    expect(() => insertKey('k1', 'repo', 'debian-12')).not.toThrow();
    expect(() => insertKey('k2', 'audit', null)).not.toThrow();
    expect(() => insertKey('k3', 'repo', null)).toThrow(/CHECK/);
    expect(() => insertKey('k4', 'audit', 'debian-12')).toThrow(/CHECK/);
  });

  it('journal de signatures en ajout seul : ni modification ni suppression', () => {
    insertKey('k1', 'repo', 'debian-12');
    insertLog(1, GENESIS);
    expect(() => db.prepare("UPDATE signature_log SET outcome = 'refused'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM signature_log').run()).toThrow(/append-only/);
    expect(db.prepare('SELECT count(*) AS n FROM signature_log').get()).toEqual({ n: 1 });
  });

  it('chaînage imposé par la base : numéro suivant et hachage précédent exacts, INSERT OR REPLACE refusé', () => {
    db.pragma('recursive_triggers = ON');
    insertKey('k1', 'repo', 'debian-12');
    expect(() => insertLog(2, GENESIS)).toThrow(/append-only/);
    expect(() => insertLog(1, 'f'.repeat(64))).toThrow(/append-only/);
    insertLog(1, GENESIS);
    expect(() => insertLog(2, GENESIS)).toThrow(/append-only/);
    insertLog(2, 'h1');
    expect(() => insertLog(2, 'h1', { verb: 'INSERT OR REPLACE', outcome: 'refused' })).toThrow(/append-only/);
    expect(db.prepare('SELECT seq, outcome FROM signature_log ORDER BY seq').all()).toEqual([
      { seq: 1, outcome: 'signed' },
      { seq: 2, outcome: 'signed' },
    ]);
  });

  it('clé absente seulement pour un refus', () => {
    insertKey('k1', 'repo', 'debian-12');
    expect(() => insertLog(1, GENESIS, { keyId: null })).toThrow(/CHECK/);
    insertLog(1, GENESIS, { keyId: null, outcome: 'refused' });
    insertLog(2, 'h1', { outcome: 'done' });
    expect(() => insertLog(3, 'h2', { outcome: 'accepted' })).toThrow(/CHECK/);
  });

  it('les migrations sont idempotentes', () => {
    expect(migrateSignerDatabase(db, NOW)).toEqual([]);
  });
});
