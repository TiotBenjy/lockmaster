# Polices de l'interface

| Police | Version | Usage | Licence | Source |
|---|---|---|---|---|
| **Inter** (variable, `wght` 100 à 900, droit + italique) | 4.001 (git-66647c0bb) | tout le texte de l'UI | SIL OFL 1.1, © 2016 The Inter Project Authors | <https://github.com/rsms/inter> |
| **JetBrains Mono** (variable, `wght` 100 à 800, droit) | 2.211 | code, versions, sha256, empreintes, identifiants CVE, snippets client | SIL OFL 1.1, © 2020 The JetBrains Mono Project Authors | <https://github.com/JetBrains/JetBrainsMono> |

## Pourquoi celles-ci

- Recommandation du skill `ui-ux-pro-max` pour le style retenu (« Minimal Swiss » : Inter, pour
  tableaux de bord, consoles d'administration, applications d'entreprise ; `docs/12` §1).
- Inter est dessinée pour l'écran aux petites tailles (14 à 16 px), a des chiffres tabulaires
  (`tnum`, indispensables aux tableaux) et un rendu identique sur Linux, Windows et macOS,
  contrairement aux polices système.
- JetBrains Mono distingue sans ambiguïté `0`/`O` et `1`/`l`/`I` : essentiel pour relire une
  empreinte de clé ou un sha256 lors d'une décision de sécurité. Ligatures désactivées dans
  `fonts.css`.

## Provenance et intégrité

Téléchargées le 2026-10-25 depuis le registre npm (sous-ensembles fontsource, fichiers identiques
aux versions amont citées) :

| Paquet npm | Intégrité (vérifiée par npm et égale à celle publiée par le registre) |
|---|---|
| `@fontsource-variable/inter@5.3.0` | `sha512-OupL48va4JNofb97w6NYeF9S7W/kHNKM0Er8Dem5nqi4jeOLrVJDoE8tZEpnMJmtkvNbB1EIPPwHcdkF6b1oUA==` |
| `@fontsource-variable/jetbrains-mono@5.3.0` | `sha512-F32xpS2NsGYoQi2ADSkKTgpJj7ozajsGgDJ8woTnqjmIB+dxDIqImjl4pXZVEExu8UFZ2ndhmX18EBS/hdz3Lw==` |

`SHA256SUMS` donne l'empreinte de chaque `.woff2` ; un test (`test/web/fonts.test.ts`, M6) la
revérifie, comme pour htmx. Vérifié à l'import avec fontTools : format WOFF2, axes variables
attendus, couverture complète du français (lettres accentuées, œ et Œ, Ÿ dans le sous-ensemble
latin-ext, guillemets « », apostrophe, euro). Seule absence : l'espace fine insécable U+202F, que
l'UI n'utilise pas (CLAUDE.md §Style d'écriture).

Sous-ensembles retenus : `latin` + `latin-ext` (le navigateur ne télécharge que ce que la page
utilise, grâce à `unicode-range`), soit 332 Kio au total. Pas de sous-ensemble cyrillique, grec ou
vietnamien : l'UI est en français et les données de paquets restent lisibles avec la police de repli.

## Règles

- Servies depuis `'self'` uniquement : la CSP contient `font-src 'self'` (ADR-0004 amendé) ; jamais
  de Google Fonts ni de CDN.
- Modifier ou ajouter une police : mêmes vérifications, mise à jour de `SHA256SUMS`, de ce fichier
  et de `docs/12` §3, dans un worktree `chore-...`.
- La licence OFL autorise la redistribution avec l'application à condition de joindre la licence
  (`LICENSE-*.txt`, à copier aussi dans le paquet `.deb`/`.rpm` et l'image, sous
  `/usr/share/doc/lockmaster/fonts/`).
