import type { Db } from '../connection.js';
import { first, qb, run } from '../query.js';

// Réglages modifiables à chaud (table setting). Les réglages réservés (audit.purge_in_progress...)
// ne passent jamais par l'API de réglages (SEC-21) : ce contrôle appartient au service des réglages.

export function getSetting(db: Db, key: string): string | undefined {
  return first(db, qb.selectFrom('setting').select('value').where('key', '=', key))?.value;
}

export function putSetting(db: Db, setting: { key: string; value: string; actor: string | null; now: number }): void {
  run(
    db,
    qb
      .insertInto('setting')
      .values({ key: setting.key, value: setting.value, updated_at: setting.now, updated_by: setting.actor })
      .onConflict((conflict) =>
        conflict
          .column('key')
          .doUpdateSet({ value: setting.value, updated_at: setting.now, updated_by: setting.actor }),
      ),
  );
}
