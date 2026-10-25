import { afterEach, describe, expect, it } from 'vitest';
import { makeTree, runScript } from '../../helpers/run-script.js';

const SCRIPT = 'scripts/check-forbidden.mjs';
// Caractères interdits construits par leur point de code : jamais écrits en clair (CLAUDE.md).
const EM_DASH = String.fromCodePoint(0x2014);
const ELLIPSIS = String.fromCodePoint(0x2026);
const CURLY_OPEN = String.fromCodePoint(0x201c);
const CURLY_CLOSE = String.fromCodePoint(0x201d);

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tree(files: Record<string, string>): string {
  const { root, cleanup } = makeTree(files);
  cleanups.push(cleanup);
  return root;
}

describe('scripts/check-forbidden.mjs', () => {
  it('accepte une arborescence propre', () => {
    const root = tree({ 'src/a.ts': "import { execFile } from 'node:child_process';\nexport const x = 1;\n" });
    const result = runScript(SCRIPT, [root]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it.each([
    ['src/a.ts', "import cp from 'node:child_process';\ncp.exec('ls');\n", 'exec'],
    ['src/a.ts', 'const run = { shell: true };\n', 'shell'],
    ['src/a.ts', 'eval("1");\n', 'eval'],
    ['src/a.ts', 'const f = new Function("return 1");\n', 'new Function'],
    ['src/a.ts', "import vm from 'node:vm';\n", 'node:vm'],
    ['src/a.tsx', 'const p = { dangerouslySetInnerHTML: {} };\n', 'dangerouslySetInnerHTML'],
    ['src/a.ts', 'process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";\n', 'TLS'],
    ['src/a.ts', 'const o = { rejectUnauthorized: false };\n', 'TLS'],
    ['src/web/p.tsx', 'const a = <div x-html="v" />;\n', 'x-html'],
    ['src/web/p.tsx', 'const a = <div hx-on:click="v" />;\n', 'hx-on'],
    ['src/web/p.tsx', 'const a = <div style="color: red" />;\n', 'style'],
    ['src/web/client/a.ts', "import Alpine from 'alpinejs';\n", 'alpinejs'],
    ['src/http/routes/x.ts', 'app.setNotFoundHandler(() => {});\n', 'setNotFoundHandler'],
  ])('refuse %s contenant un motif interdit (%#)', (path, content, label) => {
    const root = tree({ [path]: content });
    const result = runScript(SCRIPT, [root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(path);
    expect(result.stderr.toLowerCase()).toContain(label.toLowerCase());
  });

  it('refuse les caractères typographiques interdits dans les fichiers texte du projet', () => {
    const root = tree({ 'docs/x.md': `Titre ${EM_DASH} sous-titre\n`, 'deploy/a.conf': `ok${ELLIPSIS}\n` });
    const result = runScript(SCRIPT, [root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/x.md');
    expect(result.stderr).toContain('U+2014');
    expect(result.stderr).toContain('deploy/a.conf');
  });

  it('accepte setNotFoundHandler dans src/http/errors.ts seulement', () => {
    const root = tree({ 'src/http/errors.ts': 'app.setNotFoundHandler(() => {});\n' });
    expect(runScript(SCRIPT, [root]).status).toBe(0);
  });

  it('ignore les fichiers tiers vendorisés, les licences et node_modules', () => {
    const root = tree({
      'src/web/static/fonts/README.md': `${EM_DASH}\n`,
      'src/web/static/vendor/htmx.js': 'eval("x")\n',
      'LICENSE-x.txt': `${CURLY_OPEN}quoted${CURLY_CLOSE}\n`,
      'node_modules/a/index.ts': 'eval("1")\n',
    });
    const result = runScript(SCRIPT, [root]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('le dépôt lui-même respecte toutes les règles', () => {
    const result = runScript(SCRIPT, []);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
