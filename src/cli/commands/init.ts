import { chownSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { isInsideReally } from '../../config/real-path.js';
import type { Config } from '../../config/schema.js';
import { readSecretFile } from '../../config/secret-file.js';
import { generateMasterKeyText, parseMasterKey } from '../../crypto/master-key.js';
import { databasePath, markInitialized, openDatabase } from '../../db/connection.js';
import { LockmasterError } from '../../domain/errors.js';
import { type SystemAccounts, systemAccounts } from '../accounts.js';
import { type CommandContext, loadContextConfig } from '../context.js';
import { type FileOwner, writeNewFile } from '../files.js';

// `lockmaster init` (version M0) : clé maîtresse de l'application et base initialisée. Idempotent :
// ne remplace jamais une clé ni une base existante. Lancé en root (paquets), il pose les
// propriétaires attendus (root:lockmaster 0440 pour la clé, lockmaster pour les données).
// Initialisation du signataire et création du premier administrateur : jalon M2.

const SERVICE_ACCOUNT = 'lockmaster';
const MIN_ADMIN_PASSWORD_LENGTH = 12;

interface Ownership {
  key?: FileOwner;
  data?: FileOwner;
}

function ownershipFor(asRoot: boolean, accounts: SystemAccounts): Ownership {
  if (!asRoot) return {};
  const service = accounts.userIds(SERVICE_ACCOUNT);
  return { key: { uid: 0, gid: accounts.groupId(SERVICE_ACCOUNT) }, data: service };
}

function checkAdminPassword(path: string): void {
  const password = readSecretFile(path).toString('utf8').replace(/\n$/, '');
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new LockmasterError(
      'ADMIN_PASSWORD_WEAK',
      `mot de passe administrateur trop court (au moins ${MIN_ADMIN_PASSWORD_LENGTH} caractères)`,
    );
  }
}

function ensureMasterKey(config: Config, owner: FileOwner | undefined): string {
  const path = config.security.master_key_file;
  if (existsSync(path)) {
    parseMasterKey(readSecretFile(path));
    return `clé maîtresse existante conservée : ${path}`;
  }
  // Revérifiée juste avant la création : jamais sous data_dir, même à travers un lien.
  if (isInsideReally(config.server.data_dir, path)) {
    throw new LockmasterError('CONFIG_INVALID', 'security.master_key_file ne doit pas se trouver sous server.data_dir');
  }
  writeNewFile(path, generateMasterKeyText(), owner ? 0o440 : 0o400, owner);
  return `clé maîtresse créée : ${path}`;
}

function ensureDataDir(dir: string, owner: FileOwner | undefined): void {
  if (existsSync(dir)) {
    if (!lstatSync(dir).isDirectory()) throw new LockmasterError('DATA_DIR_INVALID', `${dir} n'est pas un dossier`);
    return;
  }
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  if (owner) chownSync(dir, owner.uid, owner.gid);
}

function ensureDatabase(config: Config, owner: FileOwner | undefined): string {
  const path = databasePath(config.server.data_dir);
  const existed = existsSync(path);
  const db = openDatabase(path, { create: true });
  try {
    markInitialized(db);
  } finally {
    db.close();
  }
  if (owner) chownSync(path, owner.uid, owner.gid);
  return existed ? `base existante conservée : ${path}` : `base créée : ${path}`;
}

export async function initCommand(ctx: CommandContext, accounts = systemAccounts()): Promise<number> {
  const config = loadContextConfig(ctx);
  const passwordFile = ctx.options['admin-password-file'];
  // Contrôles d'abord, effets ensuite : un refus ne laisse aucune installation à moitié faite.
  if (typeof passwordFile === 'string') checkAdminPassword(passwordFile);
  const owners = ownershipFor(ctx.runtime.uid === 0, accounts);
  const lines = [ensureMasterKey(config, owners.key)];
  ensureDataDir(config.server.data_dir, owners.data);
  lines.push(ensureDatabase(config, owners.data));
  if (typeof passwordFile === 'string') {
    lines.push('mot de passe administrateur vérifié ; le compte sera créé quand le schéma des comptes existera');
  }
  ctx.runtime.stdout.write(`${lines.join('\n')}\nInitialisation terminée.\n`);
  return 0;
}
