import {
  invalidKey,
  KEY_FINGERPRINT,
  KEY_ID,
  type KeyIdentity,
  type KeyKind,
  type KeyPurpose,
  type KeyState,
  validateKeyLine,
} from '../domain/signing-key.js';

export type { KeyIdentity, KeyKind, KeyPurpose, KeyState, RepoFormat } from '../domain/signing-key.js';
export { validateKeyLine } from '../domain/signing-key.js';

// Interface KeyStore du signataire (docs/01 §6, ADR-0009) : stocker, lire la partie publique, déchiffrer
// pour signer, changer l'état. L'identité liée à une clé (dépôt, format, Origin/Label, noms autorisés) est
// fixée à l'insertion et n'a aucune méthode de modification. Implémentations : SqliteKeyStore (clés
// scellées dans signer.db), plus tard PKCS#11 ; faux en mémoire pour les tests.

export interface KeyRecord {
  id: string;
  kind: KeyKind;
  purpose: KeyPurpose;
  fingerprint: string;
  publicKey: string;
  /** Obligatoire pour une clé de dépôt, absente pour la clé d'audit. */
  identity: KeyIdentity | null;
  state: KeyState;
  createdAt: number;
  expiresAt: number | null;
}

export interface NewKey extends KeyRecord {
  /** Clé privée en clair, scellée par l'implémentation ; jamais rendue par get ni list. */
  privateKey: string;
}

export interface KeyStore {
  insert(key: NewKey): void;
  get(id: string): KeyRecord | undefined;
  list(): KeyRecord[];
  /** Clé privée déchiffrée, pour signer en mémoire ; KEY_NOT_FOUND si absente, KEY_RETIRED si retirée. */
  privateKey(id: string): string;
  /** Change l'état si l'état actuel est l'un de `from` ; sinon KEY_STATE_CONFLICT. `retired` est définitif. */
  transition(id: string, from: readonly KeyState[], to: KeyState): void;
}

const MAX_PUBLIC_KEY = 64 * 1024;

/** Contrôles communs aux implémentations : l'identité n'étant plus modifiable après l'insertion, elle est validée ici. */
export function validateNewKey(key: NewKey): void {
  validateKeyLine(key.purpose, key.kind, key.identity);
  const valid =
    KEY_ID.test(key.id) &&
    KEY_FINGERPRINT.test(key.fingerprint) &&
    key.publicKey.length > 0 &&
    key.publicKey.length <= MAX_PUBLIC_KEY &&
    key.privateKey.length > 0;
  if (!valid) throw invalidKey();
}
