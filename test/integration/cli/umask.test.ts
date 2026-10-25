import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freePort, installation } from '../../helpers/cli.js';
import { REPO_ROOT } from '../../helpers/run-script.js';

// Le masque hérité n'est pas sûr partout (022 dans un conteneur, où le groupe principal 10101 est
// partagé avec nginx) : l'application fixe le sien (027), comme UMask= de lockmaster.service.

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('masque de création de fichiers de lockmaster', () => {
  it('aucun fichier créé par init n est accessible à « others », même avec un masque hérité de 000', async () => {
    const install = installation(await freePort());
    cleanups.push(install.cleanup);
    const tsx = join(REPO_ROOT, 'node_modules/.bin/tsx');
    const result = spawnSync(
      'sh',
      ['-c', 'umask 000; exec "$0" "$@"', tsx, 'src/main.ts', 'init', '--non-interactive', '--config', install.config],
      { cwd: REPO_ROOT, encoding: 'utf8', shell: false, timeout: 60_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    const database = join(install.dataDir, 'lockmaster.db');
    expect(statSync(database).mode & 0o027).toBe(0);
  });
});
