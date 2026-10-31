import type Database from 'better-sqlite3';
import { LockmasterError } from '../domain/errors.js';

// Transaction SQLite synchrone (docs/01 §4), commune à l'application et au signataire. better-sqlite3
// est synchrone : une fonction async verrait ses écritures postérieures à un `await` échapper à la
// transaction. Elle est donc refusée avant de commencer, et une promesse rendue annule tout.
// Écriture immédiate (BEGIN IMMEDIATE) : le verrou est pris d'emblée, pas à la première écriture.

const AsyncFunction = (async () => {}).constructor;

function asyncError(): LockmasterError {
  return new LockmasterError(
    'DB_TX_ASYNC',
    'transaction : fonction asynchrone refusée (aucun await dans une transaction)',
  );
}

function isThenable(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

export function runTransaction<T>(db: Database.Database, fn: () => T): T {
  if (fn instanceof AsyncFunction) throw asyncError();
  const run = db.transaction(() => {
    const result = fn();
    if (isThenable(result)) {
      // La promesse n'est jamais attendue : on évite seulement un rejet non géré.
      (result as Promise<unknown>).then(undefined, () => {});
      throw asyncError();
    }
    return result;
  });
  return db.inTransaction ? run() : run.immediate();
}
