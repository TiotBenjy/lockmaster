import type Database from 'better-sqlite3';
import { applyMigrations, type Migration } from '../system/sqlite-migrations.js';
import signer from './migrations/0001_signer.sql';

// Migrations de la base du signataire (signer.db, ADR-0009), embarquées dans son bundle. Même moteur
// que l'application (src/system/sqlite-migrations.ts), aucune table en commun.

export const SIGNER_MIGRATIONS: readonly Migration[] = [{ version: 1, name: 'signer', sql: signer }];

/** Applique les migrations en attente ; rend leurs noms. */
export function migrateSignerDatabase(db: Database.Database, now: number): string[] {
  return applyMigrations(db, SIGNER_MIGRATIONS, now);
}
