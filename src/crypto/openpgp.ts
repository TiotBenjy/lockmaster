import * as openpgp from 'openpgp';
import { LockmasterError } from '../domain/errors.js';

// Primitives OpenPGP (docs/02 §3.3, docs/03 §5) : clés de signature des dépôts APT/RPM et de l'audit,
// signatures en clair (InRelease) et détachées en armure (Release.gpg, repomd.xml.asc), vérification
// avant bascule d'une génération (G3) et des index amont (invariant 8).
// - Clés v4 (les clés v6 de la RFC 9580 ne sont pas lues par le gpgv des clients Debian 12), avec une
//   sous-clé de signature et une expiration ; aucune sous-clé de chiffrement.
// - Clés privées jamais protégées par phrase de passe OpenPGP : le signataire les chiffre (seal, ADR-0009).
// - Vérification : la clé émettrice doit être valide à la date fournie (maintenant), pas seulement à la
//   date déclarée par la signature, choisie par le signataire (comme gpgv : EXPKEYSIG).
// Toute erreur de la bibliothèque est rendue par un code typé, sans son message.

export type OpenPgpKeyType = 'rsa4096' | 'ed25519';

/** Durée de validité des clés de dépôt (docs/03 §5 : 2 ans). */
export const OPENPGP_KEY_VALIDITY_DAYS = 730;
const MAX_VALIDITY_DAYS = 3650;
const DAY_SECONDS = 86_400;

export interface OpenPgpKeyRequest {
  name: string;
  email?: string;
  type: OpenPgpKeyType;
  date: Date;
  validityDays: number;
}

export interface GeneratedOpenPgpKey {
  /** Clé privée en armure, non chiffrée : à sceller immédiatement, jamais journalisée. */
  privateKey: string;
  publicKey: string;
  fingerprint: string;
  /** Certificat de révocation, remis une fois à l'opérateur pour conservation hors ligne (SEC-06). */
  revocationCertificate: string;
}

const keyInvalid = () => new LockmasterError('OPENPGP_KEY_INVALID', 'clé OpenPGP illisible ou inutilisable');
const signatureInvalid = () => new LockmasterError('OPENPGP_SIGNATURE_INVALID', 'signature OpenPGP invalide');
const signFailed = () => new LockmasterError('OPENPGP_SIGN_FAILED', 'signature OpenPGP impossible avec cette clé');

export async function generateOpenPgpKey(request: OpenPgpKeyRequest): Promise<GeneratedOpenPgpKey> {
  const { validityDays } = request;
  if (!Number.isSafeInteger(validityDays) || validityDays < 1 || validityDays > MAX_VALIDITY_DAYS) {
    throw new LockmasterError('OPENPGP_KEY_REQUEST_INVALID', `durée de validité de 1 à ${MAX_VALIDITY_DAYS} jours`);
  }
  if (!Number.isFinite(request.date.getTime())) {
    throw new LockmasterError('OPENPGP_KEY_REQUEST_INVALID', 'date de création invalide');
  }
  const userIDs = [request.email === undefined ? { name: request.name } : { name: request.name, email: request.email }];
  const algorithm =
    request.type === 'rsa4096'
      ? ({ type: 'rsa', rsaBits: 4096 } as const)
      : ({ type: 'ecc', curve: 'ed25519Legacy' } as const);
  const generated = await openpgp.generateKey({
    ...algorithm,
    userIDs,
    date: request.date,
    keyExpirationTime: validityDays * DAY_SECONDS,
    subkeys: [{ sign: true }],
    format: 'armored',
  });
  const key = await openpgp.readKey({ armoredKey: generated.publicKey });
  return {
    privateKey: generated.privateKey,
    publicKey: generated.publicKey,
    fingerprint: key.getFingerprint(),
    revocationCertificate: generated.revocationCertificate,
  };
}

async function readSigningKey(armoredKey: string): Promise<openpgp.PrivateKey> {
  let key: openpgp.PrivateKey;
  try {
    key = await openpgp.readPrivateKey({ armoredKey });
  } catch {
    throw keyInvalid();
  }
  if (!key.isDecrypted()) throw keyInvalid();
  return key;
}

/** Trousseau en armure : une ou plusieurs clés publiques (deux pendant une rotation, docs/03 §5). */
async function readVerificationKeys(armoredKeys: string): Promise<openpgp.Key[]> {
  const blocks = armoredKeys.match(/-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]*?-----END PGP PUBLIC KEY BLOCK-----/g);
  if (!blocks) throw keyInvalid();
  try {
    return (await Promise.all(blocks.map((block) => openpgp.readKeys({ armoredKeys: block })))).flat();
  } catch {
    throw keyInvalid();
  }
}

async function signWith(sign: () => Promise<string>): Promise<string> {
  try {
    return await sign();
  } catch {
    throw signFailed();
  }
}

/** Signature en clair (InRelease). */
export async function clearsign(privateKey: string, text: string, date: Date): Promise<string> {
  const signingKeys = await readSigningKey(privateKey);
  const message = await openpgp.createCleartextMessage({ text });
  return signWith(() => openpgp.sign({ message, signingKeys, date, format: 'armored' }));
}

/** Signature détachée en armure (Release.gpg, repomd.xml.asc, points de contrôle d'audit). */
export async function detachSign(privateKey: string, data: Uint8Array, date: Date): Promise<string> {
  const signingKeys = await readSigningKey(privateKey);
  const message = await openpgp.createMessage({ binary: data });
  return signWith(() => openpgp.sign({ message, signingKeys, date, detached: true, format: 'armored' }));
}

type Verification = Awaited<ReturnType<typeof openpgp.verify>>;

/**
 * Au moins une signature cryptographiquement valide dont la clé émettrice (sous-clé comprise) est
 * valide à `now` : ni expirée, ni révoquée.
 */
async function requireCurrentSignature(result: Verification, keys: openpgp.Key[], now: Date): Promise<void> {
  for (const signature of result.signatures) {
    const valid = await signature.verified.then(
      () => true,
      () => false,
    );
    if (!valid) continue;
    for (const key of keys) {
      const current = await key.getSigningKey(signature.keyID, now).then(
        () => true,
        () => false,
      );
      if (current) return;
    }
  }
  throw signatureInvalid();
}

const CLEARSIGNED = /^-----BEGIN PGP SIGNED MESSAGE-----\n[\s\S]*\n-----END PGP SIGNATURE-----\n?$/;
const DELIMITERS = [
  '-----BEGIN PGP SIGNED MESSAGE-----',
  '-----BEGIN PGP SIGNATURE-----',
  '-----END PGP SIGNATURE-----',
];

/** Un seul message signé : armure au début et à la fin, chaque délimiteur présent exactement une fois. */
function isSingleClearsigned(signed: string): boolean {
  return CLEARSIGNED.test(signed) && DELIMITERS.every((line) => signed.indexOf(line) === signed.lastIndexOf(line));
}

/**
 * Vérifie une signature en clair et rend le texte signé ; seule cette valeur rendue est fiable. Tout
 * octet hors de l'armure est refusé. Les espaces de fin de ligne ne sont pas couverts par la signature
 * (RFC 4880 §7.1) et sont retirés de la valeur rendue.
 */
export async function verifyClearsigned(publicKeys: string, signed: string, now: Date): Promise<string> {
  const verificationKeys = await readVerificationKeys(publicKeys);
  if (!isSingleClearsigned(signed)) throw signatureInvalid();
  let result: Verification;
  try {
    const message = await openpgp.readCleartextMessage({ cleartextMessage: signed });
    result = await openpgp.verify({ message, verificationKeys, date: now });
  } catch {
    throw signatureInvalid();
  }
  await requireCurrentSignature(result, verificationKeys, now);
  return result.data as string;
}

/** Vérifie une signature détachée en armure sur `data` ; lève OPENPGP_SIGNATURE_INVALID sinon. */
export async function verifyDetached(
  publicKeys: string,
  data: Uint8Array,
  signature: string,
  now: Date,
): Promise<void> {
  const verificationKeys = await readVerificationKeys(publicKeys);
  let result: Verification;
  try {
    const message = await openpgp.createMessage({ binary: data });
    const parsed = await openpgp.readSignature({ armoredSignature: signature });
    result = await openpgp.verify({ message, signature: parsed, verificationKeys, date: now });
  } catch {
    throw signatureInvalid();
  }
  await requireCurrentSignature(result, verificationKeys, now);
}
