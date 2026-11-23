import type Database from 'better-sqlite3';
import { LockmasterError } from '../domain/errors.js';
import { runTransaction } from '../system/sqlite-tx.js';

// Limite de débit des signatures par clé et par minute (ADR-0009, table rate_window) : chaque demande
// `sign` sur une clé connue compte, refus compris, dans sa propre transaction (un refus ultérieur ne
// l'annule pas). Au-delà de la limite : refus SIGNER_RATE_LIMITED, journalisé comme tout refus.

export class RateLimiter {
  readonly #db: Database.Database;
  readonly #limit: number;

  constructor(db: Database.Database, limitPerMinute: number) {
    this.#db = db;
    this.#limit = limitPerMinute;
  }

  consume(keyId: string, nowMs: number): void {
    const minute = Math.floor(nowMs / 60_000);
    const count = runTransaction(this.#db, () => {
      this.#db.prepare('DELETE FROM rate_window WHERE minute < ?').run(minute - 1);
      this.#db
        .prepare(
          `INSERT INTO rate_window (key_id, minute, count) VALUES (?, ?, 1)
           ON CONFLICT (key_id, minute) DO UPDATE SET count = count + 1`,
        )
        .run(keyId, minute);
      const row = this.#db.prepare('SELECT count FROM rate_window WHERE key_id = ? AND minute = ?').get(keyId, minute);
      return (row as { count: number }).count;
    });
    if (count > this.#limit) {
      throw new LockmasterError('SIGNER_RATE_LIMITED', `plus de ${this.#limit} signatures par minute pour cette clé`);
    }
  }
}
