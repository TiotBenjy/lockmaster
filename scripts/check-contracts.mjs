#!/usr/bin/env node
// Substitution de Liskov vérifiée (CLAUDE.md §SOLID, docs/01 §6) : toute implémentation d'une interface
// déclarée dans test/contracts/registry.json, dans src/ ou test/fakes/ (`implements X` ou `satisfies X`),
// doit être importée par un test qui appelle la suite de conformité de X. Exécuté en CI.
// Usage : node scripts/check-contracts.mjs [--root=<dossier>]
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { root: { type: 'string' } } });
const root = resolve(values.root ?? join(import.meta.dirname, '..'));
const registry = JSON.parse(readFileSync(join(root, 'test/contracts/registry.json'), 'utf8'));

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') yield* walk(full);
    else if (entry.isFile() && lstatSync(full).isFile()) yield relative(root, full).split(sep).join('/');
  }
}

const read = (rel) => readFileSync(join(root, rel), 'utf8');
const sources = [...walk(join(root, 'src')), ...walk(join(root, 'test/fakes'))].filter((f) => /\.tsx?$/.test(f));
const tests = [...walk(join(root, 'test'))].filter((f) => /\.test\.tsx?$/.test(f)).map((f) => [f, read(f)]);

/** Un test couvre `impl` s'il appelle la suite et importe le module de l'implémentation. */
function covered(impl, suite) {
  const module = basename(impl).replace(/\.tsx?$/, '');
  const importsImpl = new RegExp(`from\\s+['"][^'"]*/${module}(\\.js)?['"]`);
  return tests.some(([, text]) => text.includes(`${suite}(`) && importsImpl.test(text));
}

const missing = [];
for (const rel of sources) {
  const text = read(rel);
  for (const [, iface] of text.matchAll(/\b(?:implements|satisfies)\s+([A-Z]\w*)/g)) {
    const suite = registry[iface];
    if (suite && !covered(rel, suite)) missing.push(`${rel} : implémente ${iface} sans test appelant ${suite}`);
  }
}

if (missing.length > 0) {
  process.stderr.write(`Suites de conformité manquantes (test/contracts/) :\n- ${missing.join('\n- ')}\n`);
  process.exit(1);
}
