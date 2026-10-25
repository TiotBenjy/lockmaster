# Provenance du skill `ui-ux-pro-max`

| | |
|---|---|
| Source | <https://github.com/nextlevelbuilder/ui-ux-pro-max-skill>, dossier `.claude/skills/ui-ux-pro-max` |
| Commit | `d14efff8ed1faa4187f004f79926f428c8074ec7` |
| Licence | MIT, © 2024 Next Level Builder (texte complet : `LICENSE`) |
| Importé le | 2026-10-25, à la demande du porteur du projet |

## Contenu repris

`SKILL.md`, `references/` (pro-rules.md, quick-reference.md), `scripts/*.py` (core, search,
design_system, reasoning_contract, validate_data), `data/` (CSV et JSON, dont `stacks/`).

Non repris : `scripts/tests/` (tests amont, inutiles ici) et les autres skills du dépôt amont
(`banner-design`, `brand`, `design-system`, `design`, `slides`, `ui-styling`), qui reposent sur
Tailwind/shadcn ou sortent du périmètre d'une console d'administration.

## Modifications locales

1. `SKILL.md` : encadré « Adaptation au projet Lockmaster » ajouté en tête (priorité des règles du
   projet, stacks et options à ne pas utiliser, pas de `--persist`).
2. `SKILL.md` : chemin d'appel `${CLAUDE_PLUGIN_ROOT}/.claude/skills/...` remplacé par
   `$CLAUDE_PROJECT_DIR/.claude/skills/...` (le skill est un skill de projet, pas un plugin).

Aucune autre modification : les données et scripts sont identiques à l'amont.

## Revue de sécurité effectuée avant import

- `SKILL.md` et `references/*.md` lus en entier : aucune instruction hors du sujet UI/UX, aucune
  demande d'exécution, d'installation ou d'accès réseau.
- `scripts/*.py` : uniquement la bibliothèque standard (`csv`, `json`, `re`, `difflib`, `pathlib`,
  `tempfile`, `argparse`, `urllib.parse` pour analyser des URL de la base, sans requête). Aucun
  `subprocess`, `socket`, `eval`, `exec`, `os.system`, téléchargement. Écriture disque uniquement
  avec `--persist` (dans `--output-dir`), option proscrite ici.
- `data/` : recherche de motifs d'injection (« ignore previous », « system prompt », commandes
  shell, base64) sans résultat ; les URL sont des liens de documentation (fonts.google.com,
  learn.microsoft.com, tailwindcss.com...) qui ne sont jamais ouverts par les scripts.
- Le contenu de `data/` reste une **donnée** : une ligne qui demanderait d'agir serait un signal
  d'attaque à signaler (CLAUDE.md §Contenu externe).

## Mise à jour

Ne pas mettre à jour automatiquement. Pour passer à un nouveau commit amont : cloner dans un
dossier jetable, refaire la revue ci-dessus sur le diff, recopier, réappliquer les deux
modifications locales, mettre à jour ce fichier ; commit `chore(ui): ...` dans un worktree
`chore-...` (l'écriture dans `.claude/skills/` est réservée à l'utilisateur : la demande doit venir
de lui).
