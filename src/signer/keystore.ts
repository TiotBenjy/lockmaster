import { LockmasterError } from '../domain/errors.js';

// Interface KeyStore du signataire (docs/01 §6, ADR-0009) : stocker, lire la partie publique, déchiffrer
// pour signer, changer l'état. L'identité liée à une clé (dépôt, format, Origin/Label, noms autorisés) est
// fixée à l'insertion et n'a aucune méthode de modification. Implémentations : SqliteKeyStore (clés
// scellées dans signer.db), plus tard PKCS#11 ; faux en mémoire pour les tests.

export type KeyKind = 'openpgp' | 'apk-rsa';
export type KeyPurpose = 'repo' | 'audit';
export type KeyState = 'active' | 'rotating_in' | 'rotating_out' | 'retired';
export type RepoFormat = 'deb' | 'rpm' | 'apk';

export interface KeyIdentity {
  repoName: string;
  repoFormat: RepoFormat;
  originLabel: string;
  /** Motifs de noms de paquets que cette clé peut signer (rpm-header, apk-package). */
  allowedNames: readonly string[];
}

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

const KEY_ID = /^[0-9A-Za-z_-]{1,64}$/;
const FINGERPRINT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// Même règle que les noms de dépôts de l'application (docs/05 §Notes), « .. » refusé à part.
const REPO_NAME = /^[a-z0-9][a-z0-9.-]{0,62}$/;
// Origin/Label : ASCII imprimable sans caractère de contrôle (comparé à un champ de Release).
const ORIGIN_LABEL = /^[\x21-\x7e][\x20-\x7e]{0,127}$/;
const NAME_PATTERN = /^[A-Za-z0-9*+._-]{1,128}$/;
const MAX_PUBLIC_KEY = 64 * 1024;

function identityValid(identity: KeyIdentity, kind: KeyKind): boolean {
  return (
    REPO_NAME.test(identity.repoName) &&
    !identity.repoName.includes('..') &&
    ['deb', 'rpm', 'apk'].includes(identity.repoFormat) &&
    (kind === 'apk-rsa') === (identity.repoFormat === 'apk') &&
    ORIGIN_LABEL.test(identity.originLabel) &&
    identity.allowedNames.length <= 256 &&
    identity.allowedNames.every((pattern) => NAME_PATTERN.test(pattern))
  );
}

/**
 * Contrôles communs aux implémentations : l'identité n'étant plus modifiable après l'insertion, elle est
 * validée ici (nom de dépôt, format cohérent avec le type de clé, Origin/Label, motifs de noms).
 */
export function validateNewKey(key: NewKey): void {
  const valid =
    KEY_ID.test(key.id) &&
    FINGERPRINT.test(key.fingerprint) &&
    key.publicKey.length > 0 &&
    key.publicKey.length <= MAX_PUBLIC_KEY &&
    key.privateKey.length > 0 &&
    (key.purpose === 'repo'
      ? key.identity !== null && identityValid(key.identity, key.kind)
      : key.identity === null && key.kind === 'openpgp');
  if (!valid) throw new LockmasterError('KEY_INVALID', 'clé ou identité de clé invalide');
}
