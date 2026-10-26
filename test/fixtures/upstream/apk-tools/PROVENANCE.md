# Vecteurs de comparaison de versions apk-tools

- Source : apk-tools, `test/version.data`, branche `2.14-stable`
  (https://gitlab.alpinelinux.org/alpine/apk-tools), copiée telle quelle depuis un clone du dépôt
  officiel (2026-10-26).
- Licence : GPL-2.0-only (apk-tools). Données de test seulement : jamais livrées, jamais liées au code
  de Lockmaster (MIT).
- Format : `a op b` avec op dans `< > =`, commentaire possible après `#` ; le harnais d'origine
  (`test/version.sh`) compare la sortie de `apk version -t a b`.
- Deux lignes portent une version invalide (`1.0bc`, `23_foo`) : Lockmaster refuse toute version
  invalide (FORMAT_INVALID), le test le vérifie au lieu de reproduire l'ordre d'apk sur ces cas.
- Le test e2e `test/e2e/formats/versions.test.ts` rejoue chaque ligne avec `apk version -t` dans des
  conteneurs Alpine 3.20 et 3.22 (apk-tools 2.14.4 et 2.14.12).
