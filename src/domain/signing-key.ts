import { LockmasterError } from './errors.js';

// Clés de signature (docs/03 §5, docs/05 signing_key et base du signataire) : types et validation de
// l'identité liée à une lignée de clés, partagés par le signataire (qui la fixe et l'applique) et par
// l'application (qui en garde la partie publique). Code pur, sans I/O.

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

export const KEY_ID = /^[0-9A-Za-z_-]{1,64}$/;
export const KEY_FINGERPRINT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// Même règle que les noms de dépôts de l'application (docs/05 §Notes), « .. » refusé à part.
const REPO_NAME = /^[a-z0-9][a-z0-9.-]{0,62}$/;
// Origin/Label : ASCII imprimable sans caractère de contrôle (comparé à un champ de Release).
const ORIGIN_LABEL = /^[\x21-\x7e][\x20-\x7e]{0,127}$/;
const NAME_PATTERN = /^[A-Za-z0-9*+._-]{1,128}$/;

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

export const invalidKey = () => new LockmasterError('KEY_INVALID', 'clé ou identité de clé invalide');

/**
 * Usage, type et identité d'une lignée de clés : identité obligatoire et valide pour un dépôt (nom,
 * format cohérent avec le type, Origin/Label, motifs de noms), absente pour la clé d'audit (OpenPGP).
 */
export function validateKeyLine(purpose: KeyPurpose, kind: KeyKind, identity: KeyIdentity | null): void {
  const valid =
    purpose === 'repo' ? identity !== null && identityValid(identity, kind) : identity === null && kind === 'openpgp';
  if (!valid) throw invalidKey();
}
