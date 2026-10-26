// Génère le corpus de compression (ADR-0015) avec les vrais outils `xz` et `bzip2`, en développement
// uniquement, sur des charges déterministes de confiance (builders/payloads.ts). Les flux produits
// et le manifeste sont commités ; les tests ne lancent jamais ces outils.
// Usage : pnpm exec tsx test/fixtures/corpus-generate.ts && pnpm biome check --write test/fixtures/corpus
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAYLOADS, type PayloadName } from './builders/payloads.js';

const ROOT = join(import.meta.dirname, 'corpus', 'compression');
const TOOLS = { xz: '/usr/bin/xz', bzip2: '/usr/bin/bzip2' } as const;

export interface CorpusEntry {
  readonly file: string;
  readonly compression: 'xz' | 'bzip2';
  /** Charges dont la concaténation est le résultat attendu. */
  readonly payloads: readonly PayloadName[];
  /** 'ok' ou le code d'erreur attendu. */
  readonly expect: string;
  readonly command: string;
}

interface Recipe {
  readonly name: string;
  readonly tool: keyof typeof TOOLS;
  readonly payload: PayloadName;
  readonly args: readonly string[];
  readonly expect?: string;
}

const XZ: readonly Recipe[] = [
  { name: 'empty', tool: 'xz', payload: 'empty', args: [] },
  { name: 'text-crc64', tool: 'xz', payload: 'text', args: [] },
  { name: 'text-crc32', tool: 'xz', payload: 'text', args: ['--check=crc32'] },
  { name: 'text-none', tool: 'xz', payload: 'text', args: ['--check=none'] },
  { name: 'text-sha256', tool: 'xz', payload: 'text', args: ['--check=sha256'] },
  { name: 'text-blocks', tool: 'xz', payload: 'text', args: ['--block-size=32KiB'] },
  { name: 'text-9e', tool: 'xz', payload: 'text', args: ['-9e'] },
  { name: 'text-dict-128m', tool: 'xz', payload: 'text', args: ['--lzma2=dict=128MiB'] },
  { name: 'mixed-lc1-lp3-pb0', tool: 'xz', payload: 'mixed', args: ['--lzma2=preset=6,lc=1,lp=3,pb=0'] },
  { name: 'mixed-lc4-lp0-pb4', tool: 'xz', payload: 'mixed', args: ['--lzma2=preset=6,lc=4,lp=0,pb=4'] },
  { name: 'mixed-1', tool: 'xz', payload: 'mixed', args: ['-1'] },
  { name: 'random', tool: 'xz', payload: 'random', args: [] },
  { name: 'zeros', tool: 'xz', payload: 'zeros', args: [] },
  { name: 'longrange', tool: 'xz', payload: 'longrange', args: [] },
  { name: 'interleaved', tool: 'xz', payload: 'interleaved', args: [] },
  {
    name: 'text-x86',
    tool: 'xz',
    payload: 'text',
    args: ['--x86', '--lzma2'],
    expect: 'FORMAT_UNSUPPORTED_COMPRESSION',
  },
  {
    name: 'text-delta',
    tool: 'xz',
    payload: 'text',
    args: ['--delta=dist=4', '--lzma2'],
    expect: 'FORMAT_UNSUPPORTED_COMPRESSION',
  },
  { name: 'text-lzma-alone', tool: 'xz', payload: 'text', args: ['--format=lzma'], expect: 'FORMAT_CORRUPT_STREAM' },
];

const BZIP2: readonly Recipe[] = [
  { name: 'empty', tool: 'bzip2', payload: 'empty', args: [] },
  { name: 'text-9', tool: 'bzip2', payload: 'text', args: ['-9'] },
  { name: 'text-1', tool: 'bzip2', payload: 'text', args: ['-1'] },
  { name: 'mixed-1', tool: 'bzip2', payload: 'mixed', args: ['-1'] },
  { name: 'random', tool: 'bzip2', payload: 'random', args: [] },
  { name: 'zeros', tool: 'bzip2', payload: 'zeros', args: [] },
];

function compress(recipe: Recipe): Buffer {
  const args = [...recipe.args, '-c', '-T1'].filter((arg) => recipe.tool === 'xz' || arg !== '-T1');
  return execFileSync(TOOLS[recipe.tool], args, {
    input: PAYLOADS[recipe.payload](),
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: '/usr/bin', LC_ALL: 'C' },
  });
}

function version(tool: keyof typeof TOOLS): string {
  const result = spawnSync(TOOLS[tool], ['--version'], { shell: false, env: { LC_ALL: 'C' }, input: '' });
  // bzip2 écrit sa version sur stderr (et compresse stdin sur stdout) ; xz l'écrit sur stdout.
  const lines = `${result.stderr.toString('latin1')}\n${result.stdout.toString('latin1')}`.split('\n');
  return lines.find((line) => /XZ Utils|Version \d/.test(line))?.trim() ?? tool;
}

function main(): void {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, 'xz'), { recursive: true });
  mkdirSync(join(ROOT, 'bzip2'), { recursive: true });
  const manifest: CorpusEntry[] = [];
  const outputs = new Map<string, Buffer>();
  for (const recipe of [...XZ, ...BZIP2]) {
    const extension = recipe.tool === 'xz' ? 'xz' : 'bz2';
    const file = `${recipe.tool}/${recipe.name}.${extension}`;
    const bytes = compress(recipe);
    outputs.set(file, bytes);
    writeFileSync(join(ROOT, file), bytes);
    manifest.push({
      file,
      compression: recipe.tool,
      payloads: [recipe.payload],
      expect: recipe.expect ?? 'ok',
      command: `${version(recipe.tool)} : ${recipe.tool} ${recipe.args.join(' ')}`.trim(),
    });
  }
  const concatenated = (first: string, second: string, padding: number): Buffer =>
    Buffer.concat([
      outputs.get(first) ?? Buffer.alloc(0),
      Buffer.alloc(padding),
      outputs.get(second) ?? Buffer.alloc(0),
    ]);
  writeFileSync(join(ROOT, 'xz/concatenated.xz'), concatenated('xz/text-crc32.xz', 'xz/random.xz', 4));
  manifest.push({
    file: 'xz/concatenated.xz',
    compression: 'xz',
    payloads: ['text', 'random'],
    expect: 'ok',
    command: 'text-crc32.xz + 4 octets nuls + random.xz',
  });
  writeFileSync(join(ROOT, 'bzip2/concatenated.bz2'), concatenated('bzip2/text-9.bz2', 'bzip2/random.bz2', 0));
  manifest.push({
    file: 'bzip2/concatenated.bz2',
    compression: 'bzip2',
    payloads: ['text', 'random'],
    expect: 'ok',
    command: 'text-9.bz2 + random.bz2',
  });
  writeFileSync(join(ROOT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

main();
