import { afterEach, describe, expect, it } from 'vitest';
import { makeTree, runScript } from '../../helpers/run-script.js';

const SCRIPT = 'scripts/check-contracts.mjs';
const REGISTRY = JSON.stringify({ BlobStore: 'describeBlobStoreContract' });
const IMPL = "import type { BlobStore } from './types.js';\nexport class FsBlobStore implements BlobStore {}\n";
const FAKE =
  "import type { BlobStore } from '../../src/storage/types.js';\nexport const memoryBlobs = {} satisfies BlobStore;\n";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function check(files: Record<string, string>) {
  const { root, cleanup } = makeTree({ 'test/contracts/registry.json': REGISTRY, ...files });
  cleanups.push(cleanup);
  return runScript(SCRIPT, [`--root=${root}`]);
}

describe('scripts/check-contracts.mjs (Liskov, docs/01 §6)', () => {
  it('refuse une implémentation sans appel à sa suite de conformité', () => {
    const result = check({ 'src/storage/fs-blobs.ts': IMPL });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/storage/fs-blobs.ts');
    expect(result.stderr).toContain('describeBlobStoreContract');
  });

  it('refuse un faux (satisfies) sans appel à la suite', () => {
    const result = check({ 'test/fakes/blobs.ts': FAKE });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('test/fakes/blobs.ts');
  });

  it("refuse une suite appelée par un test qui n'importe pas l'implémentation", () => {
    const result = check({
      'src/storage/fs-blobs.ts': IMPL,
      'test/unit/other.test.ts':
        "import { describeBlobStoreContract } from '../contracts/blob-store.contract.js';\n" +
        'describeBlobStoreContract(() => ({}));\n',
    });
    expect(result.status).toBe(1);
  });

  it('accepte une implémentation et un faux qui appellent leur suite', () => {
    const result = check({
      'src/storage/fs-blobs.ts': IMPL,
      'test/fakes/blobs.ts': FAKE,
      'test/unit/storage/fs-blobs.test.ts':
        "import { FsBlobStore } from '../../../src/storage/fs-blobs.js';\n" +
        "import { describeBlobStoreContract } from '../../contracts/blob-store.contract.js';\n" +
        'describeBlobStoreContract(() => new FsBlobStore());\n',
      'test/unit/fakes/blobs.test.ts':
        "import { memoryBlobs } from '../../fakes/blobs.js';\n" +
        "import { describeBlobStoreContract } from '../../contracts/blob-store.contract.js';\n" +
        'describeBlobStoreContract(() => memoryBlobs);\n',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('ignore les interfaces absentes du registre', () => {
    const result = check({ 'src/a.ts': 'export class A implements Iterable<number> {}\n' });
    expect(result.status).toBe(0);
  });

  it('le dépôt lui-même respecte la règle', () => {
    const result = runScript(SCRIPT, []);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
