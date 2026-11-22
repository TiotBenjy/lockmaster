import { join } from 'node:path';
import Database from 'better-sqlite3';
import { LockmasterError } from '../domain/errors.js';

// Base propre du signataire (signer.db, ADR-0009), distincte de celle de l'application : marqueur
// application_id, clés scellées (keystore-sqlite.ts) et journal de signatures chaîné (journal.ts).

export type SignerDb = Database.Database;

/** « LKS1 » : identifie une base du signataire. */
const SIGNER_APPLICATION_ID = 0x4c4b5331;

export const signerDatabasePath = (dataDir: string) => join(dataDir, 'signer.db');

export function openSignerDatabase(path: string, options: { create: boolean }): SignerDb {
  try {
    const db = new Database(path, { fileMustExist: !options.create });
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    // Sans lui, INSERT OR REPLACE supprime une ligne sans déclencher les triggers BEFORE DELETE.
    db.pragma('recursive_triggers = ON');
    return db;
  } catch (error) {
    throw new LockmasterError('SIGNER_DB_UNAVAILABLE', `base ${path} inutilisable : ${(error as Error).message}`);
  }
}

export function isSignerDatabase(db: SignerDb): boolean {
  return db.pragma('application_id', { simple: true }) === SIGNER_APPLICATION_ID;
}

/** Marque une base vide ; refuse une base existante d'une autre application. */
export function markSignerDatabase(db: SignerDb): void {
  if (isSignerDatabase(db)) return;
  const tables = db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'").get() as { n: number };
  if (db.pragma('application_id', { simple: true }) !== 0 || tables.n > 0) {
    throw new LockmasterError('SIGNER_DB_FOREIGN', "la base existante n'est pas une base du signataire");
  }
  db.pragma(`application_id = ${SIGNER_APPLICATION_ID}`);
}
