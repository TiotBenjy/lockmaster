import type { Db } from '../connection.js';
import { first, qb, run } from '../query.js';

// Comptes (docs/05). Les droits ne sont jamais portés par le compte : ils viennent de ses groupes
// (src/db/repos/groups.ts, ADR-0010).

export interface NewLocalAccount {
  id: string;
  username: string;
  passwordHash: string;
  now: number;
}

export function createLocalAccount(db: Db, account: NewLocalAccount): void {
  run(
    db,
    qb.insertInto('account').values({
      id: account.id,
      username: account.username,
      password_hash: account.passwordHash,
      auth_source: 'local',
      directory_connector: null,
      directory_subject: null,
      totp_secret_enc: null,
      totp_last_step: null,
      locked_until: null,
      created_at: account.now,
      last_login_at: null,
      directory_synced_at: null,
      elevated_at: null,
    }),
  );
}

/** Recherche insensible à la casse (colonne COLLATE NOCASE). */
export function findAccountByUsername(db: Db, username: string) {
  return first(
    db,
    qb
      .selectFrom('account')
      .select(['id', 'username', 'auth_source', 'disabled', 'totp_enabled', 'created_at'])
      .where('username', '=', username),
  );
}
