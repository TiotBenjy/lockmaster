# Vecteurs de comparaison de versions dpkg

- Source : dpkg, `scripts/t/Dpkg_Version.t`, section `__DATA__`
  (https://salsa.debian.org/dpkg-team/dpkg/-/raw/main/scripts/t/Dpkg_Version.t, commit
  f4941036b04e787c2803d6359802d6725d2476c6 du 2026-04-11).
- Licence : GPL-2.0-or-later (dpkg). Données de test seulement : jamais livrées, jamais liées au code
  de Lockmaster (MIT).
- Format de `version.data` : `a b résultat`, résultat = signe de la comparaison de a avec b.
- Transcription relue par un outil de résumé : le test e2e `test/e2e/formats/versions.test.ts`
  vérifie chaque ligne avec `dpkg --compare-versions` dans un conteneur Debian.
