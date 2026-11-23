import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPair,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto';
import { LockmasterError } from '../domain/errors.js';

// Signature APK (docs/02 §3.3, docs/03 §4.3) : RSA 4096, PKCS#1 v1.5 avec SHA-256, la forme des
// signatures `.SIGN.RSA256.<clé>.pub` d'apk-tools (équivalent de `openssl dgst -sha256 -sign`). La clé
// publique est distribuée en PEM SPKI, format lu par apk-tools. Seul node:crypto est utilisé.

export interface ApkRsaKey {
  /** PKCS#8 PEM non chiffré : à sceller immédiatement par le signataire, jamais journalisé. */
  privateKeyPem: string;
  publicKeyPem: string;
}

const MODULUS_BITS = 4096;
const keyInvalid = () => new LockmasterError('APK_KEY_INVALID', 'clé RSA APK illisible ou inutilisable');

export function generateApkRsaKey(): Promise<ApkRsaKey> {
  return new Promise((resolve, reject) => {
    generateKeyPair(
      'rsa',
      {
        modulusLength: MODULUS_BITS,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      },
      (error, publicKeyPem, privateKeyPem) => (error ? reject(error) : resolve({ privateKeyPem, publicKeyPem })),
    );
  });
}

function rsaKey(read: () => KeyObject): KeyObject {
  let key: KeyObject;
  try {
    key = read();
  } catch {
    throw keyInvalid();
  }
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw keyInvalid();
  return key;
}

/** Empreinte d'une clé APK : SHA-256 de la clé publique en SPKI DER (64 caractères hexadécimaux). */
export function apkKeyFingerprint(publicKeyPem: string): string {
  const key = rsaKey(() => createPublicKey(publicKeyPem));
  return createHash('sha256')
    .update(key.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

export function signApk(privateKeyPem: string, data: Uint8Array): Buffer {
  const key = rsaKey(() => createPrivateKey(privateKeyPem));
  try {
    return sign('sha256', data, key);
  } catch {
    throw new LockmasterError('APK_SIGN_FAILED', 'signature APK impossible avec cette clé');
  }
}

/** Vérifie une signature APK ; faux pour une signature fausse ou tronquée, erreur typée pour une clé illisible. */
export function verifyApk(publicKeyPem: string, data: Uint8Array, signature: Uint8Array): boolean {
  const key = rsaKey(() => createPublicKey(publicKeyPem));
  try {
    return verify('sha256', data, key, signature);
  } catch {
    return false;
  }
}
