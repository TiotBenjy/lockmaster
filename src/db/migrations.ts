import { applyMigrations, type Migration } from '../system/sqlite-migrations.js';
import type { Db } from './connection.js';
import init from './migrations/0001_init.sql';

// Migrations de la base de l'application, embarquées dans le bundle (ADR-0002). Une migration
// fusionnée n'est jamais modifiée : son empreinte est vérifiée à chaque ouverture.

export const APP_MIGRATIONS: readonly Migration[] = [{ version: 1, name: 'init', sql: init }];

/** Applique les migrations en attente ; rend leurs noms. */
export function migrateDatabase(db: Db, now: number): string[] {
  return applyMigrations(db, APP_MIGRATIONS, now);
}
