import { existsSync } from 'node:fs';
import { LockmasterError } from '../domain/errors.js';
import { pendingMigrations } from '../system/sqlite-migrations.js';
import type { SignerConfig } from './config.js';
import { type JournalRecord, SignatureJournal } from './journal.js';
import { SqliteKeyStore } from './keystore-sqlite.js';
import { SIGNER_MIGRATIONS } from './migrations.js';
import { isSignerDatabase, openSignerDatabase, type SignerDb, signerDatabasePath } from './store.js';

// Consultation locale de la base du signataire (CLI sous le compte lockmaster-signer) : parties publiques
// des clés et journal de signatures, chaîne vérifiée avant affichage. Lecture seule, sans clé maîtresse.

function openForInspection(config: SignerConfig): SignerDb {
  const path = signerDatabasePath(config.server.data_dir);
  const notReady = () =>
    new LockmasterError('NOT_INITIALIZED', `base du signataire non prête (${path}) : exécuter lockmaster signer init`);
  if (!existsSync(path)) throw notReady();
  const db = openSignerDatabase(path, { create: false });
  if (!isSignerDatabase(db) || pendingMigrations(db, SIGNER_MIGRATIONS).length > 0) {
    db.close();
    throw notReady();
  }
  return db;
}

function withDatabase<T>(config: SignerConfig, read: (db: SignerDb) => T): T {
  const db = openForInspection(config);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

const iso = (ms: number | null) => (ms === null ? '-' : new Date(ms).toISOString());

/** Une ligne par clé : identifiant, type, usage, état, dépôt, empreinte, création, expiration. */
export function keysListing(config: SignerConfig): string[] {
  return withDatabase(config, (db) =>
    new SqliteKeyStore(db, null)
      .list()
      .map((key) =>
        [
          key.id,
          key.kind,
          key.purpose,
          key.state,
          key.identity?.repoName ?? '-',
          key.fingerprint,
          iso(key.createdAt),
          iso(key.expiresAt),
        ].join('  '),
      ),
  );
}

const entryLine = (entry: JournalRecord) =>
  [entry.seq, iso(entry.at), entry.kind, entry.outcome, entry.keyId ?? '-', entry.reason ?? ''].join('  ').trimEnd();

/** Vérifie toute la chaîne puis rend la tranche demandée ; `intact` faux si le journal a été altéré. */
export function journalListing(config: SignerConfig, range: { afterSeq: number; limit: number }) {
  return withDatabase(config, (db) => {
    const journal = new SignatureJournal(db);
    const check = journal.verify();
    const summary = check.ok
      ? `chaîne vérifiée : ${check.count} ${check.count > 1 ? 'entrées' : 'entrée'}${check.head ? `, tête ${check.head.seq} ${check.head.hash}` : ''}`
      : `chaîne rompue à l'entrée ${check.brokenAt} : journal altéré`;
    return { intact: check.ok, lines: [summary, ...journal.list(range).map(entryLine)] };
  });
}
