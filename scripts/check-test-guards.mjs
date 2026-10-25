#!/usr/bin/env node
// Garde-fous des tests (SEC-19, docs/10 §Tests de sécurité). Exécuté en CI.
//  - `.only` interdit dans tout test ;
//  - `.skip`, `.todo`, `skipIf`, `runIf` interdits dans test/security/ ;
//  - le nombre de tests de test/security/ ne diminue pas par rapport à la base (--base=<réf git>).
// Usage : node scripts/check-test-guards.mjs [--root=<dossier>] [--base=<réf git>]
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { root: { type: 'string' }, base: { type: 'string' } } });
const root = resolve(values.root ?? join(import.meta.dirname, '..'));
const SECURITY_DIR = 'test/security/';
const TEST_FILE = /\.(test|spec)\.(ts|tsx|mts)$|\.contract\.ts$/;
const ONLY = /\b(it|test|describe|suite|bench)\.only\s*\(/;
const DISABLED = /\b(it|test|describe|suite)\.(skip|todo|skipIf|runIf)\s*\(/;
const TEST_CALL = /\b(it|test)(\.each\([^)]*\))?\s*\(/g;

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') yield* walk(full);
    else if (entry.isFile() && lstatSync(full).isFile()) yield relative(root, full).split(sep).join('/');
  }
}

const countTests = (text) => [...text.matchAll(TEST_CALL)].length;
const errors = [];
let securityCount = 0;

for (const rel of walk(join(root, 'test'))) {
  if (!TEST_FILE.test(rel)) continue;
  const text = readFileSync(join(root, rel), 'utf8');
  const only = text.match(ONLY);
  if (only) errors.push(`${rel} : ${only[0].trim()} interdit (.only)`);
  if (!rel.startsWith(SECURITY_DIR)) continue;
  const disabled = text.match(DISABLED);
  if (disabled) errors.push(`${rel} : test de sécurité désactivé (.${disabled[2]}) interdit`);
  securityCount += countTests(text);
}

function baseSecurityCount(base) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  const files = git(['ls-tree', '-r', '--name-only', base, '--', SECURITY_DIR])
    .split('\n')
    .filter((f) => TEST_FILE.test(f));
  return files.reduce((sum, file) => sum + countTests(git(['show', `${base}:${file}`])), 0);
}

if (values.base) {
  const before = baseSecurityCount(values.base);
  if (securityCount < before) {
    errors.push(
      `nombre de tests de ${SECURITY_DIR} en baisse par rapport à ${values.base} : ${before} -> ${securityCount}`,
    );
  }
}

if (errors.length > 0) {
  process.stderr.write(`Garde-fous des tests (SEC-19) :\n- ${errors.join('\n- ')}\n`);
  process.exit(1);
}
process.stdout.write(`Tests de sécurité : ${securityCount}\n`);
