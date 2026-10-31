// CONVENTIONS.md §Style d'écriture : caractères typographiques caractéristiques des textes générés.
// Écrits en séquences d'échappement pour que ce fichier en soit lui-même exempt.
const AI_TYPO_NAMES = new Map([
  ['\u2014', 'tiret long'],
  ['\u2013', 'tiret moyen'],
  ['\u2015', 'barre horizontale'],
  ['\u2026', 'points de suspension en un caractère (écrire ...)'],
  ['\u201c', 'guillemet anglais courbe'],
  ['\u201d', 'guillemet anglais courbe'],
  ['\u2018', 'apostrophe courbe ouvrante'],
  ['\u2022', 'puce'],
  ['\u202f', 'espace fine insécable'],
  ['\u2009', 'espace fine'],
  ['\u200b', 'espace de largeur nulle'],
]);
export const AI_TYPO =
  /[\u2013\u2014\u2015\u2018\u201c\u201d\u2022\u2026\u202f\u2009\u200b\u2190-\u21ff\u2600-\u27bf\u{1F000}-\u{1FAFF}]/u;

/** Liste lisible des caractères interdits présents dans `text` (vide si aucun). */
export function aiTypoFindings(text) {
  const found = new Map();
  const lines = String(text ?? '').split('\n');
  lines.forEach((line, i) => {
    for (const ch of line) {
      if (!AI_TYPO.test(ch)) continue;
      const cp = `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
      const name = AI_TYPO_NAMES.get(ch) ?? (/[\u2190-\u21ff]/u.test(ch) ? 'flèche' : 'emoji ou pictogramme');
      if (!found.has(cp)) found.set(cp, `${cp} ${name} (ligne ${i + 1})`);
    }
  });
  return [...found.values()];
}
