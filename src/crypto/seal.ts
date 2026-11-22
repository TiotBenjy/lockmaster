import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { LockmasterError } from '../domain/errors.js';

// Chiffrement au repos des secrets (colonnes *_enc, docs/02 §3.3, docs/05 §Notes) : AES-256-GCM, nonce
// aléatoire de 12 octets, étiquette de 16 octets. L'AAD lie le chiffré à sa place (table, colonne, clé
// primaire) : recopié sur une autre ligne, il ne se déchiffre plus. Format :
//   version (1 octet) || nonce (12) || chiffré || étiquette (16)
// Toute erreur de déchiffrement donne le même code, sans détail exploitable.

export interface SealContext {
  table: string;
  column: string;
  id: string;
}

const VERSION = 0x01;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + NONCE_BYTES;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,63}$/;

function checkKey(key: Buffer): void {
  if (key.length !== KEY_BYTES)
    throw new LockmasterError('CRYPTO_KEY_INVALID', 'clé de chiffrement de 32 octets attendue');
}

/** AAD sans ambiguïté : tableau JSON versionné (un « . » dans l'identifiant ne peut rien confondre). */
function aadOf(context: SealContext): Buffer {
  const valid =
    IDENTIFIER.test(context.table) &&
    IDENTIFIER.test(context.column) &&
    context.id.length > 0 &&
    context.id.length <= 256 &&
    !context.id.includes('\0');
  if (!valid) throw new LockmasterError('CRYPTO_CONTEXT_INVALID', 'contexte de chiffrement invalide');
  // L'octet de version fait partie de l'AAD : une future version (identifiant de clé maîtresse, SEC-16)
  // liera ainsi son en-tête au chiffré.
  return Buffer.from(JSON.stringify(['lockmaster-seal', VERSION, context.table, context.column, context.id]), 'utf8');
}

export function seal(key: Buffer, plaintext: Buffer, context: SealContext): Buffer {
  checkKey(key);
  const aad = aadOf(context);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, body, cipher.getAuthTag()]);
}

export function unseal(key: Buffer, sealed: Buffer, context: SealContext): Buffer {
  checkKey(key);
  const aad = aadOf(context);
  const failed = () => new LockmasterError('CRYPTO_UNSEAL_FAILED', 'déchiffrement impossible');
  if (sealed.length < HEADER_BYTES + TAG_BYTES || sealed[0] !== VERSION) throw failed();
  const nonce = sealed.subarray(1, HEADER_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(sealed.subarray(HEADER_BYTES, sealed.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw failed();
  }
}
