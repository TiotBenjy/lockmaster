import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SystemAccounts } from '../../src/cli/accounts.js';
import { initCommand } from '../../src/cli/commands/init.js';
import type { CommandContext } from '../../src/cli/context.js';
import type { Identity, Privileges } from '../../src/cli/privileges.js';
import { freePort, installation } from '../helpers/cli.js';

// SEC-07 / ADR-0009 : une compromission du compte de l'application (lockmaster) ne doit pas mener à
// root, sinon la séparation du signataire tombe. Scénario : l'attaquant pose des liens dans data_dir,
// qu'il contrôle, puis l'administrateur relance `lockmaster init` en root (paquets).
// Les tests ne tournent pas en root : le « superutilisateur » et le compte de service sont simulés par
// le compte courant, et le changement d'identité est observé.

const me: Identity = { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 };

interface FakePrivileges extends Privileges {
  events: string[];
}

function fakePrivileges(onEnter: () => void = () => {}): FakePrivileges {
  const events: string[] = [];
  return {
    superuser: me,
    events,
    asService: (service, fn) => {
      events.push(`enter:${service.uid}`);
      onEnter();
      try {
        return fn();
      } finally {
        events.push('exit');
      }
    },
    chownDirectory: (path, owner) => {
      events.push(`chown:${path}:${owner.uid}`);
    },
  };
}

function accounts(service: Identity = me): SystemAccounts {
  return { userIds: () => service, groupId: () => service.gid };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Installation de test ; `dataDirUnderRoot` remplace « data » comme chemin de data_dir. */
async function setup(dataDirUnderRoot?: string) {
  const install = installation(await freePort());
  cleanups.push(install.cleanup);
  if (dataDirUnderRoot) {
    const text = readFileSync(install.config, 'utf8');
    writeFileSync(install.config, text.replace(`${install.root}/data"`, `${install.root}/${dataDirUnderRoot}"`));
    install.dataDir = join(install.root, dataDirUnderRoot);
  }
  let out = '';
  const ctx: CommandContext = {
    runtime: {
      env: {},
      uid: 0,
      stdout: { write: (t: string) => (out += t) },
      stderr: { write: (t: string) => (out += t) },
    },
    options: { config: install.config, 'non-interactive': true },
  };
  return { ...install, ctx, output: () => out };
}

async function codeOf(promise: Promise<number>): Promise<string> {
  try {
    return String(await promise);
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

describe('SEC-07 : lockmaster init en root ne suit aucun lien de data_dir', () => {
  it("crée la base sous l'identité du service, jamais en root ; la clé en root 0400 (SEC-29)", async () => {
    const { ctx, dataDir, keyFile, output } = await setup();
    const dbPath = join(dataDir, 'lockmaster.db');
    const privileges = fakePrivileges(() => expect(existsSync(dbPath)).toBe(false));
    expect(await initCommand(ctx, { accounts: accounts(), privileges })).toBe(0);
    expect(privileges.events).toEqual([`chown:${dataDir}:${me.uid}`, `enter:${me.uid}`, 'exit']);
    expect(existsSync(dbPath)).toBe(true);
    // Illisible pour le compte du service hors de son unité : systemd la lui transmet (LoadCredential).
    expect(statSync(keyFile).mode & 0o777).toBe(0o400);
    expect(statSync(keyFile).gid).toBe(me.gid);
    expect(output()).toMatch(/master-key-credential\.conf/);
  });

  it('se relance sans erreur sur la clé root 0400 créée la première fois', async () => {
    const { ctx } = await setup();
    expect(await initCommand(ctx, { accounts: accounts(), privileges: fakePrivileges() })).toBe(0);
    expect(await initCommand(ctx, { accounts: accounts(), privileges: fakePrivileges() })).toBe(0);
  });

  it.each(['lockmaster.db', 'lockmaster.db-wal', 'lockmaster.db-shm'])(
    'refuse un lien %s posé dans data_dir, sans rien créer à sa cible',
    async (name) => {
      const { ctx, dataDir, root } = await setup();
      mkdirSync(dataDir, { mode: 0o750 });
      const target = join(root, 'cible-systeme');
      symlinkSync(target, join(dataDir, name));
      const result = await codeOf(initCommand(ctx, { accounts: accounts(), privileges: fakePrivileges() }));
      expect(result).toBe('DATA_DIR_UNSAFE');
      expect(existsSync(target)).toBe(false);
    },
  );

  it('refuse un data_dir existant modifiable par le groupe ou par « others »', async () => {
    const { ctx, dataDir } = await setup();
    mkdirSync(dataDir);
    chmodSync(dataDir, 0o770);
    expect(await codeOf(initCommand(ctx, { accounts: accounts(), privileges: fakePrivileges() }))).toBe(
      'DATA_DIR_UNSAFE',
    );
  });

  it("refuse un data_dir existant qui n'appartient pas au compte du service", async () => {
    const { ctx, dataDir } = await setup();
    mkdirSync(dataDir, { mode: 0o750 });
    const otherService = { uid: me.uid + 1, gid: me.gid };
    expect(await codeOf(initCommand(ctx, { accounts: accounts(otherService), privileges: fakePrivileges() }))).toBe(
      'DATA_DIR_UNSAFE',
    );
  });

  it('refuse un data_dir dont un dossier parent est un lien, sans rien créer à sa cible', async () => {
    const { ctx, root } = await setup('lien/data');
    mkdirSync(join(root, 'ailleurs'));
    symlinkSync(join(root, 'ailleurs'), join(root, 'lien'));
    expect(await codeOf(initCommand(ctx, { accounts: accounts(), privileges: fakePrivileges() }))).toBe(
      'DATA_DIR_UNSAFE',
    );
    expect(existsSync(join(root, 'ailleurs', 'data'))).toBe(false);
  });

  it('refuse un data_dir dont un dossier parent est modifiable par le groupe', async () => {
    const { ctx, root } = await setup('ouvert/data');
    mkdirSync(join(root, 'ouvert'));
    chmodSync(join(root, 'ouvert'), 0o770);
    expect(await codeOf(initCommand(ctx, { accounts: accounts(), privileges: fakePrivileges() }))).toBe(
      'DATA_DIR_UNSAFE',
    );
    expect(existsSync(join(root, 'ouvert', 'data'))).toBe(false);
  });

  it('ne crée pas de dossiers intermédiaires en root : le parent de data_dir doit exister', async () => {
    const { ctx, root } = await setup('absent/data');
    expect(await codeOf(initCommand(ctx, { accounts: accounts(), privileges: fakePrivileges() }))).toBe(
      'DATA_DIR_UNSAFE',
    );
    expect(existsSync(join(root, 'absent'))).toBe(false);
  });
});
