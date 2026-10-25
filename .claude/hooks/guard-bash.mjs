// PreToolUse (Bash) : garde-fou sur quelques commandes dangereuses ou contraires aux règles
// du projet. Les règles de permission de settings.json ne sont pas une frontière de sécurité :
// ce hook complète, il ne remplace pas la vigilance.
import { block, readHookInput } from './lib.mjs';

const cmd = String(readHookInput().tool_input?.command ?? '');

const rules = [
  [/\b(npm|yarn)\s+(i|install|add)\b/, 'Utiliser pnpm (lockfile pnpm, scripts d\'installation bloqués).'],
  [/curl[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b|wget[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/, 'curl|sh interdit : télécharger, vérifier le SHA-256, puis exécuter.'],
  [/\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME)(\s|$)/, 'Suppression récursive de / ou du home refusée.'],
  [/\bgit\s+push\b.*(--force\b|\s-f\b)/, 'git push --force refusé.'],
  [/(cat|less|head|tail|cp|scp)\s+[^;&|]*(master\.key|\.pem\b|secrets\/)/, 'Lecture de secrets refusée.'],
  [/NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0|\b(curl|wget)\b[^;&|]*\s(-k|--insecure|--no-check-certificate)\b/,
    'Désactiver la vérification TLS est interdit.'],
  [/\bchmod\s+(-R\s+)?777\b/, 'chmod 777 refusé.'],
  // Écriture de code ou de config Claude par le shell : contournerait le hook des motifs interdits (SEC-19).
  [/(>{1,2}|\btee\b(\s+-a)?)\s*["']?(\.\/)?(src|\.claude|test\/security)\//, 'Écrire dans src/, test/security/ ou .claude/ via le shell est refusé : utiliser Edit/Write.'],
  [/\b(sed|perl)\s+[^|;&]*-i[^|;&]*\s(\.\/)?(src|\.claude|test\/security)\//, 'Modification en place de src/, test/security/ ou .claude/ via le shell refusée : utiliser Edit.'],
  [/\.skip\(|\.only\(|--passWithNoTests|--coverage\.thresholds/, 'Contournement de tests refusé (SEC-19).'],
];

for (const [re, msg] of rules) {
  if (re.test(cmd)) block(`Commande refusée : ${msg}`);
}
