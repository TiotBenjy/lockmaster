# Vecteurs de comparaison de versions rpm

- Source : rpm, `tests/rpmvercmp.at`, appels `RPMVERCMP(a, b, résultat)` actifs (les lignes `dnl`
  sont exclues), tag `rpm-4.19.1-release` (https://github.com/rpm-software-management/rpm).
- Licence : GPL-2.0-or-later (rpm). Données de test seulement : jamais livrées, jamais liées au code
  de Lockmaster (MIT).
- Format de `rpmvercmp.data` : `a b résultat`, résultat = rpmvercmp(a, b).
- Vérification : les 91 lignes ont été comparées par script au fichier du tag ci-dessus (identiques,
  2026-10-26) ; le test e2e les rejoue avec `rpm` dans des conteneurs Rocky 9 et 10.
