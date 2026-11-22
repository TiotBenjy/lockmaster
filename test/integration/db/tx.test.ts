import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tx } from '../../../src/db/tx.js';

// docs/01 §4 : une transaction est courte et synchrone ; une fonction async (ou qui rend une
// promesse) est refusée, car ses écritures après un `await` échapperaient à la transaction.

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.prepare('CREATE TABLE t (v TEXT NOT NULL)').run();
});
afterEach(() => db.close());

const count = () => (db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n;
const insert = (value: string) => db.prepare('INSERT INTO t (v) VALUES (?)').run(value);

describe('tx', () => {
  it('valide et rend le résultat de la fonction', () => {
    expect(
      tx(db, () => {
        insert('a');
        return 42;
      }),
    ).toBe(42);
    expect(count()).toBe(1);
  });

  it('annule tout si la fonction lève', () => {
    expect(() =>
      tx(db, () => {
        insert('a');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(count()).toBe(0);
  });

  it('refuse une fonction async sans rien écrire', () => {
    const fn = async () => {
      insert('a');
    };
    expect(() => tx(db, fn as unknown as () => void)).toThrow(expect.objectContaining({ code: 'DB_TX_ASYNC' }));
    expect(count()).toBe(0);
  });

  it('annule une fonction qui rend une promesse', () => {
    const fn = () => {
      insert('a');
      return Promise.resolve();
    };
    expect(() => tx(db, fn)).toThrow(expect.objectContaining({ code: 'DB_TX_ASYNC' }));
    expect(count()).toBe(0);
  });

  it('une transaction imbriquée annulée ne défait que sa partie', () => {
    tx(db, () => {
      insert('externe');
      expect(() =>
        tx(db, () => {
          insert('interne');
          throw new Error('non');
        }),
      ).toThrow('non');
    });
    expect(db.prepare('SELECT v FROM t').all()).toEqual([{ v: 'externe' }]);
  });
});
