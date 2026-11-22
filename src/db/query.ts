import type { Statement } from 'better-sqlite3';
import { type Compilable, DummyDriver, Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';
import type { Db } from './connection.js';
import type { Database } from './schema.js';

// Accès typé à la base (invariant 5 : jamais de SQL concaténé). Kysely sert seulement à CONSTRUIRE
// les requêtes (aucun pilote : DummyDriver) ; better-sqlite3 les exécute de façon synchrone, ce qui
// permet de les enchaîner dans une transaction `tx` sans await (docs/01 §4). `qb` n'a aucun état.

export const qb = new Kysely<Database>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

// Instructions préparées une fois par base et par texte SQL.
const cache = new WeakMap<Db, Map<string, Statement>>();

function prepare(db: Db, query: Compilable<unknown>): { statement: Statement; parameters: unknown[] } {
  const compiled = query.compile();
  let statements = cache.get(db);
  if (!statements) {
    statements = new Map();
    cache.set(db, statements);
  }
  let statement = statements.get(compiled.sql);
  if (!statement) {
    statement = db.prepare(compiled.sql);
    statements.set(compiled.sql, statement);
  }
  return { statement, parameters: [...compiled.parameters] };
}

export function all<R>(db: Db, query: Compilable<R>): R[] {
  const { statement, parameters } = prepare(db, query);
  return statement.all(...parameters) as R[];
}

export function first<R>(db: Db, query: Compilable<R>): R | undefined {
  const { statement, parameters } = prepare(db, query);
  return statement.get(...parameters) as R | undefined;
}

export function run(db: Db, query: Compilable<unknown>): { changes: number } {
  const { statement, parameters } = prepare(db, query);
  return { changes: statement.run(...parameters).changes };
}
