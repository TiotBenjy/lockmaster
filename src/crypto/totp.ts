import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { LockmasterError } from '../domain/errors.js';

// TOTP (docs/02 §3.3) : RFC 6238 avec HMAC-SHA-1 (RFC 4226 §5.3, troncature dynamique), 6 chiffres,
// pas de 30 s, fenêtre de ±1 pas. Anti-rejeu : un code n'est accepté que si son pas est strictement
// postérieur au dernier pas accepté (`totp_last_step`), que l'appelant enregistre ensuite.

const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1;
const SECRET_BYTES = 20;
const CODE = /^[0-9]{6}$/;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / STEP_SECONDS);
}

function checkSecret(secret: Buffer): void {
  if (secret.length !== SECRET_BYTES) {
    throw new LockmasterError('TOTP_SECRET_INVALID', `secret TOTP de ${SECRET_BYTES} octets attendu`);
  }
}

function checkStep(step: number): void {
  if (!Number.isSafeInteger(step) || step < 0) throw new LockmasterError('TOTP_STEP_INVALID', 'pas TOTP invalide');
}

export function totpCode(secret: Buffer, step: number): string {
  checkSecret(secret);
  checkStep(step);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export interface TotpCheck {
  secret: Buffer;
  code: string;
  now: Date;
  /** Dernier pas accepté pour ce compte, ou null s'il n'y en a pas. */
  lastStep: number | null;
}

export type TotpResult = { ok: true; step: number } | { ok: false };

/** Vérifie un code ; en cas de succès, l'appelant enregistre `step` comme nouveau `totp_last_step`. */
export function verifyTotp(check: TotpCheck): TotpResult {
  checkSecret(check.secret);
  const current = totpStep(check.now);
  checkStep(current);
  if (!CODE.test(check.code)) return { ok: false };
  const given = Buffer.from(check.code, 'ascii');
  let accepted: number | undefined;
  // Toutes les fenêtres sont comparées, sans sortie anticipée.
  for (let step = Math.max(0, current - WINDOW); step <= current + WINDOW; step += 1) {
    const matches = timingSafeEqual(given, Buffer.from(totpCode(check.secret, step), 'ascii'));
    if (matches && accepted === undefined) accepted = step;
  }
  if (accepted === undefined) return { ok: false };
  if (check.lastStep !== null && accepted <= check.lastStep) return { ok: false };
  return { ok: true, step: accepted };
}

/** Base32 RFC 4648 sans remplissage (format des applications d'authentification). */
export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}
