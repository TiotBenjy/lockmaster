import { existsSync, lstatSync, mkdirSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';
import { isInsideReally } from '../../config/real-path.js';
import type { Config } from '../../config/schema.js';
import { readSecretFile, type SecretFileOptions } from '../../config/secret-file.js';
import { generateMasterKeyText, parseMasterKey } from '../../crypto/master-key.js';
import { databasePath, markInitialized, openDatabase } from '../../db/connection.js';
import { LockmasterError } from '../../domain/errors.js';
import { writeNewFile } from '../../system/files.js';
import { type SystemAccounts, systemAccounts } from '../accounts.js';
import { type CommandContext, loadContextConfig } from '../context.js';
import { type Identity, type Privileges, processPrivileges } from '../privileges.js';

// `lockmaster init` (version M0) : clé maîtresse de l'application et base initialisée. Idempotent :
// ne remplace jamais une clé ni une base existante. Lancé en root (paquets) : clé root:root 0400,
// que systemd transmet au service (LoadCredential=, SEC-29) ; la base est créée sous l'identité du
// service (src/cli/privileges.ts), jamais en root.
// Initialisation du signataire et création du premier administrateur : jalon M2.

const SERVICE_ACCOUNT = 'lockmaster';
const CREDENTIAL_HINT =
  'clé transmise au service par systemd (LoadCredential) ; pour la chiffrer avec systemd-creds : ' +
  '/usr/share/doc/lockmaster/examples/master-key-credential.conf';
const MIN_ADMIN_PASSWORD_LENGTH = 12;
const DATABASE_FILES = ['', '-wal', '-shm', '-journal'];

export interface InitDeps {
  accounts: SystemAccounts;
  privileges: Privileges;
}

/** En root : identités en jeu. Hors root : l'init travaille sous le compte courant. */
interface RootMode {
  privileges: Privileges;
  service: Identity;
}

function unsafe(path: string, reason: string): LockmasterError {
  return new LockmasterError('DATA_DIR_UNSAFE', `${path} : ${reason} ; refus de continuer en root`);
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

function ensureMasterKey(config: Config, root: RootMode | undefined): string {
  const path = config.security.master_key_file;
  if (existsSync(path)) {
    const options: SecretFileOptions = root
      ? {
          allowedUids: [root.privileges.superuser.uid],
          // root:root 0400, ou root:lockmaster 0440 (versions antérieures à LoadCredential).
          allowedGids: [root.privileges.superuser.gid, root.service.gid],
        }
      : {};
    parseMasterKey(readSecretFile(path, options));
    return `clé maîtresse existante conservée : ${path}`;
  }
  // Revérifiée juste avant la création : jamais sous data_dir, même à travers un lien.
  if (isInsideReally(config.server.data_dir, path)) {
    throw new LockmasterError('CONFIG_INVALID', 'security.master_key_file ne doit pas se trouver sous server.data_dir');
  }
  writeNewFile(path, generateMasterKeyText(), 0o400, root?.privileges.superuser);
  return root ? `clé maîtresse créée : ${path}\n${CREDENTIAL_HINT}` : `clé maîtresse créée : ${path}`;
}

/**
 * En root, chaque dossier parent de data_dir doit être sûr (à la manière d'OpenSSH) : vrai dossier,
 * appartenant à root, non modifiable par le groupe ni par « others » (sauf dossier à sticky bit).
 * Sinon le compte du service pourrait orienter la création faite par root.
 */
function checkAncestors(dir: string, root: RootMode): void {
  const rootUids = [0, root.privileges.superuser.uid];
  for (let current = dirname(dir); ; current = dirname(current)) {
    let stat: Stats;
    try {
      stat = lstatSync(current);
    } catch {
      throw unsafe(current, "dossier parent absent (aucun dossier intermédiaire n'est créé en root)");
    }
    if (!stat.isDirectory()) throw unsafe(current, 'dossier parent qui est un lien ou un fichier');
    if (!rootUids.includes(stat.uid)) throw unsafe(current, `dossier parent appartenant à ${stat.uid} et non à root`);
    if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
      throw unsafe(current, 'dossier parent modifiable par le groupe ou par « others »');
    }
    if (current === dirname(current)) return;
  }
}

function ensureDataDir(dir: string, root: RootMode | undefined): void {
  if (root) checkAncestors(dir, root);
  if (!existsSync(dir) && !isLink(dir)) {
    if (root) {
      // Dernier segment seulement, propriétaire posé sur le dossier ouvert sans suivre de lien.
      mkdirSync(dir, { mode: 0o750 });
      root.privileges.chownDirectory(dir, root.service);
    } else {
      mkdirSync(dir, { recursive: true, mode: 0o750 });
    }
    return;
  }
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) throw new LockmasterError('DATA_DIR_INVALID', `${dir} n'est pas un dossier`);
  if (!root) return;
  if (stat.uid !== root.service.uid)
    throw unsafe(dir, `propriétaire ${stat.uid}, attendu le compte ${SERVICE_ACCOUNT}`);
  if ((stat.mode & 0o022) !== 0) throw unsafe(dir, 'modifiable par le groupe ou par « others »');
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function ensureDatabase(config: Config, root: RootMode | undefined): string {
  const path = databasePath(config.server.data_dir);
  for (const suffix of DATABASE_FILES) {
    if (isLink(`${path}${suffix}`)) throw unsafe(`${path}${suffix}`, 'lien symbolique inattendu');
  }
  const existed = existsSync(path);
  const create = () => {
    const db = openDatabase(path, { create: true });
    try {
      markInitialized(db);
    } finally {
      db.close();
    }
  };
  if (root) root.privileges.asService(root.service, create);
  else create();
  return existed ? `base existante conservée : ${path}` : `base créée : ${path}`;
}

export async function initCommand(
  ctx: CommandContext,
  deps: InitDeps = { accounts: systemAccounts(), privileges: processPrivileges() },
): Promise<number> {
  const config = loadContextConfig(ctx);
  const passwordFile = ctx.options['admin-password-file'];
  // Contrôles d'abord, effets ensuite : un refus ne laisse aucune installation à moitié faite.
  if (typeof passwordFile === 'string') checkAdminPassword(passwordFile);
  const root: RootMode | undefined =
    ctx.runtime.uid === 0
      ? {
          privileges: deps.privileges,
          service: deps.accounts.userIds(SERVICE_ACCOUNT),
        }
      : undefined;
  const lines = [ensureMasterKey(config, root)];
  ensureDataDir(config.server.data_dir, root);
  lines.push(ensureDatabase(config, root));
  if (typeof passwordFile === 'string') {
    lines.push('mot de passe administrateur vérifié ; le compte sera créé quand le schéma des comptes existera');
  }
  ctx.runtime.stdout.write(`${lines.join('\n')}\nInitialisation terminée.\n`);
  return 0;
}
