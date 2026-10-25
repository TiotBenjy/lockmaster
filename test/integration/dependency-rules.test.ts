import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTree, REPO_ROOT } from '../helpers/run-script.js';

// Les règles de couches (.dependency-cruiser.cjs, docs/01 §6) sont vérifiées sur des arborescences
// minimales : chaque règle doit refuser l'import qu'elle interdit.
const DEPCRUISE = join(REPO_ROOT, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs');
const CONFIG = join(REPO_ROOT, '.dependency-cruiser.cjs');
const TSCONFIG = JSON.stringify({
  compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', strict: true },
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function cruise(files: Record<string, string>) {
  const { root, cleanup } = makeTree({ 'tsconfig.json': TSCONFIG, ...files });
  cleanups.push(cleanup);
  const result = spawnSync(process.execPath, [DEPCRUISE, 'src', '--config', CONFIG, '--output-type', 'err'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const exporting = 'export const x = 1;\n';

describe('règles de couches (dependency-cruiser)', () => {
  it.each([
    [
      'pure-core-no-node-io',
      { 'src/domain/a.ts': "import { readFileSync } from 'node:fs';\nexport const a = readFileSync;\n" },
    ],
    [
      'pure-core-no-io-module',
      { 'src/formats/a.ts': "import { x } from '../db/b.js';\nexport const a = x;\n", 'src/db/b.ts': exporting },
    ],
    [
      'http-web-no-db',
      { 'src/http/a.ts': "import { x } from '../db/b.js';\nexport const a = x;\n", 'src/db/b.ts': exporting },
    ],
    [
      'only-signer-imports-signer',
      {
        'src/publish/a.ts': "import { x } from '../signer/b.js';\nexport const a = x;\n",
        'src/signer/b.ts': exporting,
      },
    ],
    [
      'signer-isolated',
      { 'src/signer/a.ts': "import { x } from '../db/b.js';\nexport const a = x;\n", 'src/db/b.ts': exporting },
    ],
    ['signer-no-network-api', { 'src/signer/a.ts': "import http from 'node:http';\nexport const a = http;\n" }],
    [
      'web-client-isolated',
      {
        'src/web/client/a.ts': "import { x } from '../../config/b.js';\nexport const a = x;\n",
        'src/config/b.ts': exporting,
      },
    ],
    ['web-client-no-node', { 'src/web/client/a.ts': "import { join } from 'node:path';\nexport const a = join;\n" }],
    [
      'sandbox-no-secrets',
      {
        'src/pipeline/sandbox/a.ts': "import { x } from '../../crypto/b.js';\nexport const a = x;\n",
        'src/crypto/b.ts': exporting,
      },
    ],
    [
      'targets-independent',
      {
        'src/publish/targets/local.ts': "import { x } from './rsync.js';\nexport const a = x;\n",
        'src/publish/targets/rsync.ts': exporting,
      },
    ],
    [
      'no-circular',
      {
        'src/a.ts': "import { b } from './b.js';\nexport const a = b;\n",
        'src/b.ts': "import { a } from './a.js';\nexport const b = a;\n",
      },
    ],
  ])("la règle %s refuse l'import interdit", (rule, files) => {
    const result = cruise(files);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(rule);
  });

  it('accepte les imports autorisés', () => {
    const result = cruise({
      'src/publish/targets/local.ts': "import type { T } from './types.js';\nexport const a: T = 1;\n",
      'src/publish/targets/types.ts': 'export type T = number;\n',
      'src/http/a.ts': "import { x } from '../signer-client/b.js';\nexport const a = x;\n",
      'src/signer-client/b.ts': exporting,
      'src/signer/a.ts': "import { createServer } from 'node:net';\nexport const a = createServer;\n",
    });
    expect(result.output).not.toContain('error');
    expect(result.status).toBe(0);
  });
});
