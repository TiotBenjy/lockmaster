#!/usr/bin/env node
// Contrôle CI des motifs interdits (CLAUDE.md §Invariants, §Style d'écriture ; docs/09 M0).
// Mêmes règles que les hooks .claude/hooks/guard-forbidden-patterns.mjs, appliquées à tout le dépôt :
// les hooks corrigent tôt, ce script est le contrôle. Usage : node scripts/check-forbidden.mjs [racine]
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { aiTypoFindings } from '../.claude/hooks/lib.mjs';

const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..'));

const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'coverage', '.data', '.data-keys', 'worktrees']);
const TEXT_FILE =
  /\.(md|ts|tsx|mts|cts|js|mjs|cjs|json|toml|ya?ml|sql|css|sh|conf|service|socket|container|network|volume|txt|html|tsv|csv)$|(^|\/)(Containerfile|Dockerfile|CODEOWNERS)$/;
const VENDORED =
  /^(\.claude\/skills\/ui-ux-pro-max\/(?!VENDORED\.md$)|src\/web\/static\/(fonts|vendor)\/|test\/fixtures\/(corpus|upstream)\/)|(^|\/)LICENSE[^/]*$/;

const SRC_RULES = [
  [
    /\b(child_process|childProcess|cp)\.exec(Sync)?\s*\(|(^|[^.\w$])exec(Sync)?\s*\(/m,
    'child_process.exec interdit (invariant 3)',
  ],
  [/\bshell\s*:\s*true\b/, 'shell: true interdit (invariant 3)'],
  [/\beval\s*\(/, 'eval interdit (invariant 3)'],
  [/\bnew\s+Function\s*\(/, 'new Function interdit (invariant 3)'],
  [/from\s+['"]node:vm['"]|from\s+['"]vm['"]|require\(\s*['"](node:)?vm['"]\s*\)/, 'node:vm interdit (invariant 3)'],
  [/dangerouslySetInnerHTML/, 'dangerouslySetInnerHTML interdit (invariant 10)'],
  [
    /NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized\s*:\s*false/,
    'désactivation de la vérification TLS interdite (invariant 8)',
  ],
];
const WEB_RULES = [
  [/\bx-html\b/, 'x-html interdit (ADR-0011)'],
  [/\shx-on(:|-|=)/, 'hx-on interdit (ADR-0011)'],
  [/\sstyle=/, 'attribut style= interdit (CSP)'],
  [
    /from\s+['"]alpinejs['"]|import\s+['"]alpinejs['"]|require\(\s*['"]alpinejs['"]\s*\)/,
    "import 'alpinejs' interdit : build CSP (ADR-0011)",
  ],
];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* walk(full);
    } else if (entry.isFile() && lstatSync(full).isFile()) {
      yield relative(root, full).split(sep).join('/');
    }
  }
}

const findings = [];
for (const rel of walk(root)) {
  if (VENDORED.test(rel) || rel.startsWith('node_modules/')) continue;
  const isSource = /^src\/.*\.(ts|tsx|mts)$/.test(rel);
  if (!TEXT_FILE.test(rel) && !isSource) continue;
  const text = readFileSync(join(root, rel), 'utf8');
  for (const finding of aiTypoFindings(text)) findings.push(`${rel} : caractère interdit ${finding}`);
  if (!isSource) continue;
  const rules = rel.startsWith('src/web/') ? [...SRC_RULES, ...WEB_RULES] : SRC_RULES;
  // Un gestionnaire 404 supplémentaire échapperait au contrôle d'accès (src/http/authorize.ts).
  if (rel !== 'src/http/errors.ts' && /\bsetNotFoundHandler\s*\(/.test(text)) {
    findings.push(`${rel} : setNotFoundHandler réservé à src/http/errors.ts (invariant 7)`);
  }
  for (const [pattern, message] of rules) {
    if (pattern.test(text)) findings.push(`${rel} : ${message}`);
  }
}

if (findings.length > 0) {
  process.stderr.write(`Motifs interdits (CLAUDE.md) :\n- ${findings.join('\n- ')}\n`);
  process.exit(1);
}
