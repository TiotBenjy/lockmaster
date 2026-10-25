import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer } from '../../../src/cli/commands/serve.js';
import { loadConfig } from '../../../src/config/load.js';
import { cli, freePort, installation } from '../../helpers/cli.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('serveur démarré après init', () => {
  it('répond sur /healthz et /readyz, healthcheck renvoie 0, puis 1 une fois arrêté', async () => {
    const install = installation(await freePort());
    cleanups.push(install.cleanup);
    expect((await cli(['init', '--non-interactive', '--config', install.config])).code).toBe(0);

    const config = loadConfig({ path: install.config, env: {} });
    const running = await startServer(config);
    let stopped = false;
    cleanups.push(async () => {
      if (!stopped) await running.stop();
    });

    const base = `http://127.0.0.1:${config.http.listen.port}`;
    expect(await (await fetch(`${base}/healthz`)).text()).toBe('ok');
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect((await cli(['healthcheck', '--config', install.config])).code).toBe(0);

    await running.stop();
    stopped = true;
    expect((await cli(['healthcheck', '--config', install.config])).code).toBe(1);
  });

  // lockmaster.service limite les familles d'adresses (RestrictAddressFamilies=AF_UNIX AF_INET
  // AF_INET6) : lister les interfaces réseau (netlink) y échoue avec EAFNOSUPPORT.
  it('écoute sur toutes les interfaces sans énumérer les interfaces réseau', async () => {
    const install = installation(await freePort());
    cleanups.push(install.cleanup);
    expect((await cli(['init', '--non-interactive', '--config', install.config])).code).toBe(0);
    const port = await freePort();
    const config = loadConfig({ path: install.config, env: { LOCKMASTER__HTTP__LISTEN: `0.0.0.0:${port}` } });
    const interfaces = vi.spyOn(os, 'networkInterfaces').mockImplementation(() => {
      throw Object.assign(new Error('uv_interface_addresses'), { code: 'EAFNOSUPPORT' });
    });
    cleanups.push(() => interfaces.mockRestore());

    const running = await startServer(config);
    cleanups.push(() => running.stop());
    expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).text()).toBe('ok');
    expect(interfaces).not.toHaveBeenCalled();
  });
});
