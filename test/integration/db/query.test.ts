import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase } from '../../../src/db/connection.js';
import { migrateDatabase } from '../../../src/db/migrations.js';
import { all, first, qb, run } from '../../../src/db/query.js';
import { tx } from '../../../src/db/tx.js';

// Kysely construit les requêtes (typées, paramétrées : invariant 5), better-sqlite3 les exécute de
// façon synchrone, donc utilisables dans une transaction `tx` sans await (docs/01 §4).

let db: Db;
beforeEach(() => {
  db = openDatabase(':memory:', { create: true });
  migrateDatabase(db, 0);
});
afterEach(() => db.close());

const setting = (key: string, value: string) =>
  qb.insertInto('setting').values({ key, value, updated_at: 1, updated_by: null });

describe('requêtes Kysely synchrones', () => {
  it('insère, lit une ligne et en liste plusieurs', () => {
    expect(run(db, setting('a', '1')).changes).toBe(1);
    run(db, setting('b', '2'));
    expect(first(db, qb.selectFrom('setting').select(['key', 'value']).where('key', '=', 'a'))).toEqual({
      key: 'a',
      value: '1',
    });
    expect(first(db, qb.selectFrom('setting').selectAll().where('key', '=', 'zz'))).toBeUndefined();
    expect(all(db, qb.selectFrom('setting').select('key').orderBy('key'))).toEqual([{ key: 'a' }, { key: 'b' }]);
  });

  it('les valeurs sont des paramètres, jamais du SQL', () => {
    const hostile = "x'); DROP TABLE setting; --";
    run(db, setting(hostile, 'v'));
    expect(all(db, qb.selectFrom('setting').select('key'))).toEqual([{ key: hostile }]);
  });

  it("fonctionne dans une transaction synchrone, annulée en cas d'erreur", () => {
    expect(() =>
      tx(db, () => {
        run(db, setting('a', '1'));
        run(db, setting('a', '2'));
      }),
    ).toThrow(/UNIQUE/);
    expect(all(db, qb.selectFrom('setting').select('key'))).toEqual([]);
  });
});
