# Lockmaster : kit de démarrage pour Claude Code

**Lockmaster** (*package lockmaster*) est un gestionnaire de dépôts de paquets APT, RPM et APK privés,
avec analyse antivirus et CVE avant publication. Ce dossier contient tout ce qu'il faut pour que
Claude Code le construise, jalon par jalon. Il n'y a pas encore de code applicatif, seulement les
spécifications, la configuration de référence et les garde-fous.

Deux composants séparés :
- l'**application** en TypeScript (Node 24 LTS) : API, interface d'administration, pipeline de
  sécurité et publication. Elle est livrée en **.deb, .rpm et image Docker/Podman**, avec son
  **service de signature** `lockmaster-signer` (même code, autre compte Linux, aucun réseau, seul
  détenteur des clés) ;
- le **serveur de dépôt** : un **nginx standard** qui sert les fichiers signés que l'application lui
  publie (dossier partagé sur le même hôte, ou envoi rsync/SSH vers un serveur distant). Il est
  livré comme un petit paquet `lockmaster-repo` sans code, ou comme un conteneur nginx officiel.

Licence : MIT. Propriétaire du dépôt GitHub : TiotBenjy.

## Décisions prises

| Sujet | Décision | Où |
|---|---|---|
| Langage et stack | TypeScript, Node 24 LTS, Fastify, SQLite | ADR-0001, ADR-0002 |
| Séparation | application, signataire séparé, serveur de dépôt nginx | ADR-0008, ADR-0009 |
| Livraison | .deb, .rpm, image OCI (Docker et Podman rootless) | ADR-0007 |
| Distributions | Debian 12 et 13, Rocky/RHEL/Alma 9 et 10 ; clients Alpine 3.20+ | `docs/09` |
| Formats | APT, RPM et APK | `docs/03` |
| Clés | une clé de signature par dépôt | SEC-05 |
| Identité | groupes locaux et groupes d'annuaire (AD en LDAPS et OIDC), accès de secours si l'AD tombe | ADR-0010 |
| MFA | TOTP pour les comptes locaux et LDAPS ; MFA de l'IdP prouvée pour OIDC, sinon TOTP | ADR-0010 §5 |
| Interface | rendu serveur, htmx, Alpine.js build CSP, polices Inter et JetBrains Mono, icônes Phosphor | ADR-0004, ADR-0011, `docs/12` |
| Méthode | TDD, SOLID, worktrees, commits locaux, aucun push par l'agent | `CLAUDE.md` |
| Après la v1 | cible de publication S3, HSM | `docs/09` |

## Contenu

| Chemin | Rôle |
|---|---|
| `CLAUDE.md` | Instructions chargées par Claude Code : stack, arborescence, commandes, invariants de sécurité, SOLID, TDD, style d'écriture, flux git |
| `docs/00-perimetre-et-pieges.md` | Périmètre fonctionnel et pièges à éviter (identifiants S, G, A, R repris partout) |
| `docs/01` à `docs/10` | Architecture (avec SOLID et règles de couches), sécurité, formats, scan et politique, schéma SQLite, API/CLI, UI, exploitation, feuille de route, tests |
| `docs/11-analyse-securite.md` | Analyse de sécurité globale : exigences SEC-01 à SEC-30 (normatives) |
| `docs/12-systeme-de-design.md` | Système de design : couleurs vérifiées AA en clair et en sombre, typographie, composants, accessibilité |
| `docs/adr/` | 11 décisions d'architecture |
| `src/web/static/fonts/` | Polices Inter et JetBrains Mono (woff2 variables, licences OFL, empreintes SHA-256, `fonts.css`) |
| `packaging/` | Unités systemd (application, signataire, socket), comptes, dossier du socket, générateur de la config nginx conteneur |
| `deploy/` | Configurations de référence (`lockmaster.example.toml`, `signer.example.toml`), compose, quadlets Podman à deux comptes, nginx du serveur de dépôt |
| `.claude/settings.json` | Permissions (secrets illisibles, push interdit) et branchement des hooks |
| `.claude/hooks/` | Garde-fous : motifs de code interdits, règles Alpine/CSP, style d'écriture, flux git (worktrees, TDD), formatage, vérifications avant de rendre la main |
| `.claude/agents/` | `security-reviewer`, `formats-expert`, `test-engineer`, `packaging-engineer`, `researcher` (web en lecture seule) |
| `.claude/skills/` | `/jalon`, `/integrer`, `/revue-securite`, `/adr`, `/migration-sql`, `/e2e-client`, et `ui-ux-pro-max` (règles UX et accessibilité, vendorisé, MIT, voir `VENDORED.md`) |
| `.claude/rules/` | Règles chargées selon le dossier modifié (formats, sécurité, HTTP, UI, packaging, signataire) |
| `.github/` | Modèles d'issues (bogue, fonctionnalité, compatibilité client, CVE publique), modèle de PR, CODEOWNERS, Dependabot |
| `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SUPPORT.md`, `LICENSE` | Fichiers communautaires du dépôt GitHub |

## Démarrer

```bash
cd lockmaster
git init -b main && git add -A && git commit -m "chore: kit de spécification Lockmaster"
git remote add origin git@github.com:TiotBenjy/lockmaster.git && git push -u origin main
claude            # Claude Code lit CLAUDE.md
```

Dans Claude Code :

```
/jalon M0          # squelette, .deb/.rpm/image vides mais installables, CI
/jalon             # jalon suivant, jusqu'à M10
/revue-securite    # à tout moment, sur le diff courant
```

Claude Code travaille dans un worktree par tâche, committe localement, puis intègre par
`/integrer` (merge `--ff-only` dans la branche de départ). Il ne pousse jamais : c'est vous qui
poussez.

Prérequis sur la machine de développement : Node.js 24, pnpm 10, Docker ou Podman (tests e2e avec
les vrais clients `apt`, `dnf`, `apk`), Python 3 (outil de recherche du skill UI), git.

## Réglages GitHub à faire une fois

- Activer le signalement privé de vulnérabilités (Settings > Code security) et l'analyse des
  secrets avec protection à l'envoi.
- Protéger `main` : PR obligatoire, CI verte, revue des CODEOWNERS.
- Activer les Discussions (lien « Poser une question » des modèles d'issues).
- Créer les étiquettes utilisées par les modèles : `bogue`, `à trier`, `fonctionnalité`,
  `compatibilité`, `sécurité`, `dépendances`, `ci`, `livraison`.

## À savoir

- L'agent ne peut pas modifier `.claude/` (règle de permission) : c'est à vous de le faire.
- Les décisions qui attendent le jalon concerné (décodeur xz en M1, politique CVE par défaut à faire
  valider en M4, durée de conservation de l'audit en M8) seront proposées par Claude Code sous
  forme d'ADR.
