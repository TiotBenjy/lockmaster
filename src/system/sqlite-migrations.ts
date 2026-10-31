import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { LockmasterError } from '../domain/errors.js';

// Moteur de migrations SQLite commun à la base de l'application (src/db/) et à celle du signataire
// (src/signer/), qui ne partagent rien d'autre (ADR-0009). Règles (ADR-0002, docs/05) :
//  - migrations numérotées 1, 2, 3... sans trou, une transaction par migration ;
//  - l'empreinte SHA-256 de chaque migration appliquée est enregistrée : une migration modifiée
//    après coup, ou une base plus récente que le code, est refusée (jamais de retour arrière) ;
//  - en-tête `-- lockmaster:foreign_keys=off` : clés étrangères désactivées AVANT la transaction
//    (le pragma est sans effet dedans), `PRAGMA foreign_key_check` avant validation, puis réactivées.

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

type Db = Database.Database;

const FOREIGN_KEYS_OFF = /^-- lockmaster:foreign_keys=off\s*$/m;

const label = (migration: Migration) => `${String(migration.version).padStart(4, '0')}_${migration.name}`;
const checksum = (sql: string) => createHash('sha256').update(sql, 'utf8').digest('hex');

function fail(code: string, message: string, cause?: unknown): LockmasterError {
  return new LockmasterError(code, message, cause === undefined ? undefined : { cause });
}

function checkList(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1 || !/^[a-z0-9_]+$/.test(migration.name)) {
      throw fail('DB_MIGRATION_INVALID', `migration ${label(migration)} mal numérotée ou mal nommée`);
    }
  });
}

function ensureTable(db: Db): void {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS schema_migration (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)`,
  ).run();
}

/** Migrations à appliquer ; refuse une base plus récente ou une migration modifiée. */
export function pendingMigrations(db: Db, migrations: readonly Migration[]): Migration[] {
  checkList(migrations);
  ensureTable(db);
  const applied = db.prepare('SELECT version, sha256 FROM schema_migration ORDER BY version').all() as Array<{
    version: number;
    sha256: string;
  }>;
  for (const row of applied) {
    const known = migrations[row.version - 1];
    if (!known) {
      throw fail('DB_TOO_NEW', `base au schéma ${row.version}, plus récent que ce programme (${migrations.length})`);
    }
    if (checksum(known.sql) !== row.sha256) {
      throw fail('DB_MIGRATION_MISMATCH', `la migration ${label(known)} a changé depuis son application`);
    }
  }
  return migrations.slice(applied.length);
}

function applyOne(db: Db, migration: Migration, now: number): void {
  const foreignKeysOff = FOREIGN_KEYS_OFF.test(migration.sql);
  if (foreignKeysOff) db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(migration.sql);
      if (foreignKeysOff && (db.pragma('foreign_key_check') as unknown[]).length > 0) {
        throw fail('DB_MIGRATION_FAILED', `migration ${label(migration)} : clés étrangères rompues`);
      }
      db.prepare('INSERT INTO schema_migration (version, name, sha256, applied_at) VALUES (?, ?, ?, ?)').run(
        migration.version,
        migration.name,
        checksum(migration.sql),
        now,
      );
    })();
  } catch (error) {
    if (error instanceof LockmasterError) throw error;
    throw fail('DB_MIGRATION_FAILED', `migration ${label(migration)} en échec : ${(error as Error).message}`, error);
  } finally {
    if (foreignKeysOff) db.pragma('foreign_keys = ON');
  }
}

/** Applique les migrations en attente ; rend leurs noms (`0002_xxx`). */
export function applyMigrations(db: Db, migrations: readonly Migration[], now: number): string[] {
  const pending = pendingMigrations(db, migrations);
  for (const migration of pending) applyOne(db, migration, now);
  return pending.map(label);
}
