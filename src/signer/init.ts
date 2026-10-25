import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { readSecretFile } from '../config/secret-file.js';
import { generateMasterKeyText, parseMasterKey } from '../crypto/master-key.js';
import { LockmasterError } from '../domain/errors.js';
import { writeNewFile } from '../system/files.js';
import type { SignerConfig } from './config.js';
import { markSignerDatabase, openSignerDatabase, signerDatabasePath } from './store.js';

// `lockmaster signer init`, exécuté sous le compte lockmaster-signer (jamais en root) : clé
// maîtresse du signataire (distincte de celle de l'application) si absente, dossier de données
// 0700 et base marquée. Idempotent, ne remplace jamais une clé ni une base.

export function initSigner(config: SignerConfig): string[] {
  const lines: string[] = [];
  const keyFile = config.security.master_key_file;
  if (existsSync(keyFile)) {
    parseMasterKey(readSecretFile(keyFile));
    lines.push(`clé maîtresse du signataire existante conservée : ${keyFile}`);
  } else {
    writeNewFile(keyFile, generateMasterKeyText(), 0o400);
    lines.push(`clé maîtresse du signataire créée : ${keyFile}`);
  }
  const dir = config.server.data_dir;
  if (existsSync(dir) || lstatSafe(dir)) {
    const stat = lstatSync(dir);
    if (!stat.isDirectory()) throw new LockmasterError('DATA_DIR_INVALID', `${dir} n'est pas un dossier`);
    if ((stat.mode & 0o077) !== 0) {
      throw new LockmasterError('DATA_DIR_UNSAFE', `${dir} est accessible à d'autres comptes (0700 attendu)`);
    }
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const path = signerDatabasePath(dir);
  const existed = existsSync(path);
  const db = openSignerDatabase(path, { create: true });
  try {
    markSignerDatabase(db);
  } finally {
    db.close();
  }
  lines.push(existed ? `base du signataire conservée : ${path}` : `base du signataire créée : ${path}`);
  return lines;
}

function lstatSafe(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
