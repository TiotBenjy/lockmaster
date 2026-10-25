#!/usr/bin/env node
// Licences de l'arbre de production (CLAUDE.md §Licence). Exécuté en CI.
// Usage : node scripts/check-licenses.mjs [--input=<sortie de pnpm licenses list --prod --json>]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0']);
// Exception unique : openpgp, module séparé non modifié et remplaçable (CLAUDE.md §Licence).
const EXCEPTIONS = new Map([['openpgp', new Set(['LGPL-3.0-or-later'])]]);

const { values } = parseArgs({ options: { input: { type: 'string' } } });
const raw = values.input
  ? readFileSync(values.input, 'utf8')
  : execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
      cwd: join(import.meta.dirname, '..'),
      encoding: 'utf8',
      shell: false,
      maxBuffer: 64 * 1024 * 1024,
    });

/** Expression SPDX simple : « A OR B » accepte si une branche l'est, « A AND B » exige les deux. */
function isAllowed(expression, accepted) {
  const spdx = expression.trim().replace(/^\((.*)\)$/, '$1');
  if (/\sOR\s/.test(spdx)) return spdx.split(/\s+OR\s+/).some((part) => isAllowed(part, accepted));
  if (/\sAND\s/.test(spdx)) return spdx.split(/\s+AND\s+/).every((part) => isAllowed(part, accepted));
  return accepted.has(spdx);
}

const report = raw.trim() ? JSON.parse(raw) : {};
const refused = [];
for (const [license, packages] of Object.entries(report)) {
  for (const { name, versions } of packages) {
    const accepted = new Set([...ALLOWED, ...(EXCEPTIONS.get(name) ?? [])]);
    if (!isAllowed(license, accepted)) refused.push(`${name}@${versions.join(',')} : ${license}`);
  }
}

if (refused.length > 0) {
  process.stderr.write(`Licences refusées dans l'arbre de production :\n- ${refused.join('\n- ')}\n`);
  process.exit(1);
}
