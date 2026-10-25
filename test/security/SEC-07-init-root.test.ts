import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync } from 'node:fs';
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
    chown: (path, owner) => {
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

async function setup() {
  const install = installation(await freePort());
  cleanups.push(install.cleanup);
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
  it("crée la base sous l'identité du service, jamais en root ; la clé en 0440 avec le groupe du service", async () => {
    const { ctx, dataDir, keyFile } = await setup();
    const dbPath = join(dataDir, 'lockmaster.db');
    const privileges = fakePrivileges(() => expect(existsSync(dbPath)).toBe(false));
    expect(await initCommand(ctx, { accounts: accounts(), privileges })).toBe(0);
    expect(privileges.events).toEqual([`chown:${dataDir}:${me.uid}`, `enter:${me.uid}`, 'exit']);
    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(keyFile).mode & 0o777).toBe(0o440);
  });

  it('se relance sans erreur sur la clé root:<groupe du service> 0440 créée la première fois', async () => {
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
});
