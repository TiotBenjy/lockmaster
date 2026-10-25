import { join } from 'node:path';
import Database from 'better-sqlite3';
import { LockmasterError } from '../domain/errors.js';

// Connexion SQLite (ADR-0002). En M0, la base ne porte que son marqueur d'initialisation
// (PRAGMA application_id) ; le schéma et les migrations arrivent en M2.

export type Db = Database.Database;

/** « LKM1 » : identifie une base lockmaster (en-tête SQLite, octets 68 à 71). */
export const APPLICATION_ID = 0x4c4b4d31;

export const databasePath = (dataDir: string) => join(dataDir, 'lockmaster.db');

export function openDatabase(path: string, options: { create: boolean }): Db {
  let db: Db;
  try {
    db = new Database(path, { fileMustExist: !options.create });
    db.pragma('journal_mode = WAL');
  } catch (error) {
    throw new LockmasterError('DB_UNAVAILABLE', `base ${path} inutilisable : ${(error as Error).message}`);
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  return db;
}

export function isInitialized(db: Db): boolean {
  return db.pragma('application_id', { simple: true }) === APPLICATION_ID;
}

/** Marque une base vide comme base lockmaster ; refuse une base existante d'une autre application. */
export function markInitialized(db: Db): void {
  if (isInitialized(db)) return;
  const id = db.pragma('application_id', { simple: true });
  const tables = db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'").get() as { n: number };
  if (id !== 0 || tables.n > 0) {
    throw new LockmasterError('DB_FOREIGN', "la base existante n'est pas une base lockmaster : refus de la modifier");
  }
  db.pragma(`application_id = ${APPLICATION_ID}`);
}

/** Vérification de disponibilité pour /readyz. */
export function ping(db: Db): boolean {
  return (db.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
}
