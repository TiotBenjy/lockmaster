# Lockmaster

**Lockmaster** est un gestionnaire de dépôts de paquets APT, RPM et APK privés, avec analyse antivirus
et CVE avant publication. Le projet est en cours de construction, jalon par jalon
(`docs/09-feuille-de-route.md`).

Deux composants séparés :
- l'**application** en TypeScript (Node 24 LTS) : API, interface d'administration, pipeline de
  sécurité et publication. Elle est livrée en **.deb, .rpm et image Docker/Podman**, avec son
  **service de signature** `lockmaster-signer` (même code, autre compte Linux, aucun réseau, seul
  détenteur des clés) ;
- le **serveur de dépôt** : un **nginx standard** qui sert les fichiers signés que l'application lui
  publie (dossier partagé sur le même hôte, ou envoi rsync/SSH vers un serveur distant). Il est
  livré comme un petit paquet `lockmaster-repo` sans code, ou comme un conteneur nginx officiel.

Licence : MIT.

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
| Méthode | TDD, SOLID, une branche locale par tâche, intégration par merge `--ff-only` | `CONVENTIONS.md` |
| Après la v1 | cible de publication S3, HSM | `docs/09` |

## Contenu

| Chemin | Rôle |
|---|---|
| `CONVENTIONS.md` | Règles du projet : stack, arborescence, commandes, invariants de sécurité, SOLID, TDD, style d'écriture, branches |
| `docs/00-perimetre-et-pieges.md` | Périmètre fonctionnel et pièges à éviter (identifiants S, G, A, R repris partout) |
| `docs/01` à `docs/10` | Architecture (avec SOLID et règles de couches), sécurité, formats, scan et politique, schéma SQLite, API/CLI, UI, exploitation, feuille de route, tests |
| `docs/11-analyse-securite.md` | Analyse de sécurité globale : exigences SEC-01 à SEC-30 (normatives) |
| `docs/12-systeme-de-design.md` | Système de design : couleurs vérifiées AA en clair et en sombre, typographie, composants, accessibilité |
| `docs/adr/` | Décisions d'architecture |
| `docs/guide/` | Installation, réglages de sécurité du dépôt GitHub |
| `src/` | Application et signataire |
| `test/` | Tests unitaires, d'intégration, de sécurité, de conformité, fuzzing et e2e |
| `packaging/` | nfpm (.deb/.rpm), Containerfile, unités systemd, comptes, générateur de la config nginx conteneur |
| `deploy/` | Configurations de référence (`lockmaster.example.toml`, `signer.example.toml`), compose, quadlets Podman à deux comptes, nginx du serveur de dépôt |
| `.github/` | CI, modèles d'issues et de PR, CODEOWNERS, Dependabot |
| `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SUPPORT.md`, `LICENSE` | Fichiers communautaires |

## Démarrer

Prérequis : Node.js 24, pnpm 12 (version épinglée par `packageManager`), Docker ou Podman (tests e2e
avec les vrais clients `apt`, `dnf`, `apk`), git.

```bash
pnpm install --frozen-lockfile
pnpm dev:init      # configuration et données de développement jetables
pnpm dev
pnpm check         # Biome + TypeScript + règles de couches
pnpm test          # unitaires et intégration
```

La contribution est décrite dans `CONTRIBUTING.md`, l'installation dans `docs/guide/installation.md`.
