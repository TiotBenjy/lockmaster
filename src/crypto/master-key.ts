import { randomBytes } from 'node:crypto';
import { LockmasterError } from '../domain/errors.js';

// Clé maîtresse (docs/02 §3.3) : 32 octets aléatoires, stockés en base64 sur une ligne.

export const MASTER_KEY_BYTES = 32;
const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;

/** Nouvelle clé maîtresse, au format du fichier (base64 + fin de ligne). */
export function generateMasterKeyText(): string {
  return `${randomBytes(MASTER_KEY_BYTES).toString('base64')}\n`;
}

/** Décode le contenu d'un fichier de clé maîtresse ; refuse tout autre format. */
export function parseMasterKey(content: Buffer): Buffer {
  const text = content.toString('utf8').replace(/\n$/, '');
  if (!BASE64_32_BYTES.test(text)) {
    throw new LockmasterError(
      'MASTER_KEY_INVALID',
      `clé maîtresse invalide : ${MASTER_KEY_BYTES} octets en base64 attendus (lockmaster keys gen-master)`,
    );
  }
  return Buffer.from(text, 'base64');
}
