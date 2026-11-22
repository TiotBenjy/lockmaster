import { LockmasterError } from '../../src/domain/errors.js';
import {
  type KeyRecord,
  type KeyState,
  type KeyStore,
  type NewKey,
  validateNewKey,
} from '../../src/signer/keystore.js';

const copy = (record: KeyRecord): KeyRecord => ({
  ...record,
  identity: record.identity === null ? null : { ...record.identity, allowedNames: [...record.identity.allowedNames] },
});

/** Clés en mémoire, mêmes règles que SqliteKeyStore (suite keystore.contract.ts). */
export class MemoryKeyStore implements KeyStore {
  readonly #keys = new Map<string, NewKey>();

  insert(key: NewKey): void {
    validateNewKey(key);
    const duplicate = [...this.#keys.values()].some(
      (other) => other.id === key.id || other.fingerprint === key.fingerprint,
    );
    if (duplicate) throw new LockmasterError('KEY_EXISTS', 'clé déjà présente');
    this.#keys.set(key.id, { ...copy(key), privateKey: key.privateKey });
  }

  get(id: string): KeyRecord | undefined {
    const key = this.#keys.get(id);
    if (!key) return undefined;
    const { privateKey: _secret, ...record } = key;
    return copy(record);
  }

  list(): KeyRecord[] {
    return [...this.#keys.keys()].map((id) => this.get(id)).filter((record): record is KeyRecord => !!record);
  }

  privateKey(id: string): string {
    const key = this.#keys.get(id);
    if (!key) throw new LockmasterError('KEY_NOT_FOUND', 'clé inconnue');
    if (key.state === 'retired') throw new LockmasterError('KEY_RETIRED', 'clé retirée');
    return key.privateKey;
  }

  transition(id: string, from: readonly KeyState[], to: KeyState): void {
    const key = this.#keys.get(id);
    if (!key) throw new LockmasterError('KEY_NOT_FOUND', 'clé inconnue');
    if (key.state === 'retired' || !from.includes(key.state)) {
      throw new LockmasterError('KEY_STATE_CONFLICT', 'état de clé inattendu');
    }
    key.state = to;
  }
}
