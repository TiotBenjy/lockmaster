import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, type Migration, pendingMigrations } from '../../../src/system/sqlite-migrations.js';

// Moteur de migrations commun à la base de l'application et à celle du signataire : une transaction
// par migration, empreinte de chaque migration appliquée, refus d'une base plus récente ou d'une
// migration modifiée après coup.

const NOW = 1_800_000_000_000;
const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function memory(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  dbs.push(db);
  return db;
}

const first: Migration = { version: 1, name: 'init', sql: 'CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT);' };
const second: Migration = { version: 2, name: 'b', sql: 'CREATE TABLE b (a_id INTEGER REFERENCES a(id));' };

function tables(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
  ).map((row) => row.name);
}

describe('applyMigrations', () => {
  it("applique les migrations dans l'ordre et les enregistre avec leur empreinte", () => {
    const db = memory();
    expect(applyMigrations(db, [first, second], NOW)).toEqual(['0001_init', '0002_b']);
    expect(tables(db)).toEqual(['a', 'b', 'schema_migration']);
    const rows = db.prepare('SELECT version, name, sha256, applied_at FROM schema_migration').all();
    expect(rows).toEqual([
      { version: 1, name: 'init', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), applied_at: NOW },
      { version: 2, name: 'b', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), applied_at: NOW },
    ]);
  });

  it("est idempotent et n'applique que les migrations en attente", () => {
    const db = memory();
    applyMigrations(db, [first], NOW);
    expect(pendingMigrations(db, [first, second]).map((m) => m.version)).toEqual([2]);
    expect(applyMigrations(db, [first, second], NOW)).toEqual(['0002_b']);
    expect(applyMigrations(db, [first, second], NOW)).toEqual([]);
  });

  it('refuse une migration déjà appliquée dont le contenu a changé', () => {
    const db = memory();
    applyMigrations(db, [first], NOW);
    const edited = { ...first, sql: `${first.sql}\nCREATE TABLE c (x);` };
    expect(() => applyMigrations(db, [edited], NOW)).toThrow(
      expect.objectContaining({ code: 'DB_MIGRATION_MISMATCH' }),
    );
    expect(tables(db)).not.toContain('c');
  });

  it("refuse une base plus récente que l'application (pas de retour arrière)", () => {
    const db = memory();
    applyMigrations(db, [first, second], NOW);
    expect(() => applyMigrations(db, [first], NOW)).toThrow(expect.objectContaining({ code: 'DB_TOO_NEW' }));
  });

  it('refuse une liste de migrations mal numérotée', () => {
    expect(() => applyMigrations(memory(), [second], NOW)).toThrow(
      expect.objectContaining({ code: 'DB_MIGRATION_INVALID' }),
    );
    expect(() => applyMigrations(memory(), [first, first], NOW)).toThrow(
      expect.objectContaining({ code: 'DB_MIGRATION_INVALID' }),
    );
  });

  it("annule entièrement une migration qui échoue, sans l'enregistrer", () => {
    const db = memory();
    const broken: Migration = { version: 2, name: 'broken', sql: 'CREATE TABLE ok (x); CREATE TABLE a (y);' };
    expect(() => applyMigrations(db, [first, broken], NOW)).toThrow(
      expect.objectContaining({ code: 'DB_MIGRATION_FAILED' }),
    );
    expect(tables(db)).toEqual(['a', 'schema_migration']);
    expect(pendingMigrations(db, [first, broken])).toHaveLength(1);
  });

  it('migration « foreign_keys=off » : clés étrangères vérifiées avant validation', () => {
    const db = memory();
    applyMigrations(db, [first, second], NOW);
    db.prepare('INSERT INTO a (id, v) VALUES (1, ?)').run('x');
    db.prepare('INSERT INTO b (a_id) VALUES (1)').run();
    // Reconstruction de table (procédure SQLite en 12 étapes) qui laisse une référence pendante.
    const rebuild: Migration = {
      version: 3,
      name: 'rebuild',
      sql: '-- lockmaster:foreign_keys=off\nCREATE TABLE a2 (id INTEGER PRIMARY KEY, v TEXT);\nDROP TABLE a;\nALTER TABLE a2 RENAME TO a;',
    };
    expect(() => applyMigrations(db, [first, second, rebuild], NOW)).toThrow(
      expect.objectContaining({ code: 'DB_MIGRATION_FAILED' }),
    );
    expect(db.prepare('SELECT count(*) AS n FROM a').get()).toEqual({ n: 1 });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

    const copying: Migration = {
      ...rebuild,
      sql: '-- lockmaster:foreign_keys=off\nCREATE TABLE a2 (id INTEGER PRIMARY KEY, v TEXT);\nINSERT INTO a2 SELECT id, v FROM a;\nDROP TABLE a;\nALTER TABLE a2 RENAME TO a;',
    };
    expect(applyMigrations(db, [first, second, copying], NOW)).toEqual(['0003_rebuild']);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
