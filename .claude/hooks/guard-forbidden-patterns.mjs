// PreToolUse (Edit|Write) : refuse d'écrire dans src/ du code qui viole un invariant de
// sécurité de CLAUDE.md. Le contrôle définitif reste le test CI équivalent : ce hook sert à
// corriger tôt, pas à garantir.
import { aiTypoFindings, block, readHookInput, relToProject } from './lib.mjs';

const input = readHookInput();
const toolInput = input.tool_input ?? {};
const rel = relToProject(toolInput.file_path);

// CLAUDE.md §Style d'écriture : pas de tics typographiques d'IA dans les fichiers du projet.
// Exclus : fichiers tiers vendorisés, licences, données de test binaires ou générées.
const TEXT_FILE = /\.(md|ts|tsx|mts|cts|js|mjs|cjs|json|toml|ya?ml|sql|css|sh|conf|service|socket|container|network|volume|txt|html|tsv|csv)$|(^|\/)(Containerfile|Dockerfile|CODEOWNERS)$/;
const VENDORED = /^(\.claude\/skills\/ui-ux-pro-max\/(?!VENDORED\.md$)|src\/web\/static\/(fonts|vendor)\/|test\/fixtures\/(corpus|upstream)\/)|(^|\/)LICENSE[^/]*$/;
if (rel && !rel.startsWith('..') && TEXT_FILE.test(rel) && !VENDORED.test(rel)) {
  const written = [toolInput.content, toolInput.new_string].filter(Boolean).join('\n');
  const findings = aiTypoFindings(written);
  if (findings.length > 0) {
    block(
      `Écriture refusée dans ${rel} : caractères typographiques interdits (CLAUDE.md §Style d'écriture) :\n- ${findings.join('\n- ')}\n` +
        'Remplacer : tiret long ou moyen -> « : », virgule ou parenthèses ; ... ; « » ou " ; -> ; pas d\'emoji. ' +
        'Dans un test, écrire le caractère en séquence d\'échappement (\\u2014).',
    );
  }
}

// SEC-19 : pas de test focalisé ni de test de sécurité désactivé.
if (/^test\/.*\.(ts|tsx|mts)$/.test(rel)) {
  const t = [toolInput.content, toolInput.new_string].filter(Boolean).join('\n');
  if (/\b(it|test|describe)\.only\s*\(/.test(t)) block(`Écriture refusée dans ${rel} : .only interdit (SEC-19).`);
  if (/^test\/security\//.test(rel) && /\b(it|test|describe)\.(skip|todo)\s*\(|\bskipIf\s*\(/.test(t)) {
    block(`Écriture refusée dans ${rel} : désactiver un test de sécurité est interdit (SEC-19).`);
  }
  process.exit(0);
}
if (!/^src\/.*\.(ts|tsx|mts)$/.test(rel)) process.exit(0);

// Texte qui sera présent après l'action (Write : contenu complet ; Edit : nouveau fragment).
const text = [toolInput.content, toolInput.new_string].filter(Boolean).join('\n');
if (!text) process.exit(0);

const rules = [
  [/\b(child_process|childProcess|cp)\.exec(Sync)?\s*\(|(^|[^.\w$])exec(Sync)?\s*\(/m,
    'child_process.exec/execSync interdit : utiliser execFile/spawn avec tableau d\'arguments et shell:false (invariant 3).'],
  [/\bshell\s*:\s*true\b/, 'shell:true interdit (invariant 3).'],
  [/\beval\s*\(|\bnew\s+Function\s*\(/, 'eval / new Function interdits (invariant 3).'],
  [/from\s+['"]node:vm['"]|require\(['"]vm['"]\)/, 'node:vm interdit (invariant 3).'],
  [/dangerouslySetInnerHTML/, 'dangerouslySetInnerHTML interdit, sans exception (invariant 10).'],
  [/NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized\s*:\s*false/, 'Désactiver la vérification TLS est interdit (invariant 8).'],
  [/\bMath\.random\s*\(/, 'Math.random interdit pour du code applicatif : utiliser node:crypto (randomBytes/randomInt).'],
  [/createHash\(\s*['"](md5|sha1)['"]\s*\)/,
    'md5/sha1 seulement pour les champs de compatibilité des métadonnées (src/formats/**) ou le C: APK.', /^src\/formats\//],
  [/\.(prepare|exec)\s*\(\s*`[^`]*\$\{/, 'SQL construit par interpolation interdit : requête préparée ou Kysely (invariant 5).'],
  [/\bas\s+any\b|:\s*any\b/, 'any interdit : utiliser unknown + validation zod.'],
];

// ADR-0009 : séparation application / service de signature.
if (!rel.startsWith('src/signer/') && /from\s+['"][^'"]*\/signer\/|import\(\s*['"][^'"]*\/signer\//.test(text)) {
  rules.push([/./, "L'application ne doit pas importer src/signer/ : utiliser src/signer-client/ (ADR-0009)."]);
}
if (rel.startsWith('src/signer/')) {
  rules.push([
    /from\s+['"](node:)?(http|https|http2|dgram|tls)['"]|from\s+['"](undici|node-fetch|axios)['"]|\bfetch\s*\(|\.connect\s*\(\s*\{?\s*(port|host)\b/,
    'Le service de signature ne doit utiliser aucune API réseau (ADR-0009) : socket Unix uniquement.',
  ]);
}

// ADR-0011 / .claude/rules/ui.md : Alpine.js build CSP, interface sans HTML injecté.
if (/from\s+['"]alpinejs['"]|require\(\s*['"]alpinejs['"]\s*\)/.test(text)) {
  rules.push([/./, "Build standard d'Alpine interdite (exige unsafe-eval) : importer '@alpinejs/csp' (ADR-0011)."]);
}
if (rel.startsWith('src/web/')) {
  rules.push(
    [/\bx-html\b/, 'x-html interdit (ADR-0011) : afficher du texte avec x-text, ou rendre le HTML côté serveur en TSX.'],
    [/\sstyle=\{|\sstyle="/, 'Attribut style inline interdit (CSP style-src self) : utiliser une classe et les jetons de app.css.'],
    [/\son[A-Z][A-Za-z]*=\{|\son[a-z]+="/, 'Gestionnaire on* inline interdit (CSP) : utiliser un composant Alpine (x-on:...).'],
    [/\shx-on(:|-|=)|\shx-vars=|\bjs:/, 'hx-on, hx-vars et les valeurs « js: » évaluent du code (interdits ; htmx.config.allowEval = false).'],
    [/\s@[a-z][\w.-]*=|\s:[a-z][\w-]*="/,'Raccourcis Alpine @/: invalides en JSX : écrire x-on:... et x-bind:... (ADR-0011).'],
  );
  // Valeurs d'attributs Alpine : références simples uniquement (« !nom » toléré, « a in b » pour x-for).
  const simple = /^!?[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
  const forExpr = /^[A-Za-z_$][\w$]*(\s*,\s*[A-Za-z_$][\w$]*)?\s+in\s+[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
  const flagOnly = /^x-(cloak|ignore|transition(:[\w.-]+)?)$/;
  for (const m of text.matchAll(/\s(x-[a-z]+(?::[\w.:-]+)?)\s*=\s*(?:"([^"]*)"|\{\s*['"]([^'"]*)['"]\s*\})/g)) {
    const [, attr, v1, v2] = m;
    const value = (v1 ?? v2 ?? '').trim();
    if (flagOnly.test(attr)) continue;
    const ok = attr === 'x-for' ? forExpr.test(value) : simple.test(value);
    if (!ok) {
      rules.push([/./, `Expression Alpine trop complexe : ${attr}="${value}". Déplacer la logique dans le composant (src/web/client/components/) et ne référencer qu'un nom (ADR-0011).`]);
    }
  }
}
if (rel.startsWith('src/web/client/')) {
  rules.push(
    [/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/,
      'Injection de HTML interdite dans les composants Alpine (ADR-0011) : manipuler du texte (textContent) ou laisser htmx/TSX produire le HTML.'],
    [/\bfetch\s*\(|XMLHttpRequest/, 'Pas de requête directe depuis un composant Alpine : passer par htmx (en-tête CSRF, contrôle serveur) (ADR-0011).'],
  );
}

const violations = [];
for (const [re, msg, allowed] of rules) {
  if (allowed instanceof RegExp && allowed.test(rel)) continue;
  if (typeof allowed === 'string' && rel === allowed) continue;
  if (re.test(text)) violations.push(`- ${msg}`);
}

if (violations.length > 0) {
  block(`Écriture refusée dans ${rel} :\n${violations.join('\n')}\nVoir CLAUDE.md §Invariants et docs/02-securite.md.`);
}
