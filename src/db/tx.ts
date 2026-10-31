import { runTransaction } from '../system/sqlite-tx.js';
import type { Db } from './connection.js';

/** Transaction synchrone de la base de l'application (docs/01 §4) ; voir src/system/sqlite-tx.ts. */
export function tx<T>(db: Db, fn: () => T): T {
  return runTransaction(db, fn);
}
