# ADR-0001 : Un seul service TypeScript (Node 24 LTS) au lieu de 5 conteneurs

- Statut : accepté, amendé par ADR-0008 (l'application ne sert plus les fichiers de dépôt ;
  ils sont servis par un nginx séparé) et par ADR-0009 (signature dans un processus séparé,
  `lockmaster-signer`, sous un autre compte, même code), et par ADR-0014 (pnpm 12 au lieu de pnpm 10)
- Date : 2026-10-19

## Contexte

Une architecture classique pour ce type d'outil empile plusieurs conteneurs (base PostgreSQL,
backend, frontend servi par nginx, un nginx par format), plusieurs fichiers compose superposables
et plusieurs fichiers d'environnement dont la précédence piège l'opérateur. Le backend y embarque
reprepro, createrepo_c, rpm, dpkg, gpg + gpg-agent, clamd, Grype, un client SSH et un client
PostgreSQL. La cohérence entre la base, les index des outils système, des fichiers JSON et les
fichiers servis par nginx finit par reposer sur des scripts de réparation (piège R1).

Contraintes du porteur du projet : langages maîtrisés **Python, C#, JS, TS, PHP** ; choix
retenu : **TypeScript**. Livrables : **.deb, .rpm, image OCI (Docker et Podman)**.

## Décision

Le produit est **un seul processus Node.js** (`lockmaster`), écrit en TypeScript strict, qui :

- sert l'API JSON et l'interface web (rendu serveur) ; les fichiers des dépôts sont publiés vers
  un serveur nginx séparé (ADR-0008) ;
- parse et valide nativement `.deb`, `.rpm`, `.apk` (code TS, pas d'outils système) ;
- génère nativement les métadonnées APT (`Packages`, `Release`, `InRelease`, by-hash),
  RPM (`repodata/*.xml.gz`, `repomd.xml`, `repomd.xml.asc`) et APK (`APKINDEX.tar.gz` signé) ;
- signe nativement (OpenPGP.js pour APT/RPM, `node:crypto` RSA pour APK) ;
- planifie ses tâches en interne.

Les seules dépendances externes restent les **scanners** (ClamAV via le socket `clamd`,
Grype en sous-processus), parce que réimplémenter un antivirus ou une base CVE n'a pas de sens.

## Stack retenue

| Besoin | Choix | Pourquoi |
|---|---|---|
| Runtime | **Node.js 24 LTS** (EOL avril 2028), compatible 26 LTS | Node 22 est en fin de vie en avril 2027 |
| Langage | TypeScript `strict`, ESM, `noUncheckedIndexedAccess` | Typage fort sur du parsing binaire |
| HTTP | **Fastify 5** + plugins officiels `@fastify/*` | Streaming d'upload, hooks, logs pino, rate-limit, helmet, cookies, CSRF |
| Validation / OpenAPI | **zod** + `fastify-type-provider-zod` + `@fastify/swagger` | Un schéma = validation + types + doc |
| Base | **SQLite** (`better-sqlite3`) + **Kysely** (requêtes typées) | Voir ADR-0002 |
| UI | **Preact + preact-render-to-string** (TSX rendu serveur, aucune hydratation) + **htmx** | Voir ADR-0004 |
| OpenPGP | **openpgp** (OpenPGP.js v6) | Clés, signatures en clair (`InRelease`) et détachées |
| Crypto, hash, zlib, zstd | `node:crypto`, `node:zlib` (gzip + zstd natifs dans Node 24) | Zéro dépendance |
| Archives | `tar-stream` ; décodeur **xz** pur JS/WASM (à sélectionner en M1) | `.deb` utilisent xz/zstd pour `control.tar` |
| OIDC | `openid-client` v6 | Bibliothèque de référence |
| Planification | `croner` | Minuscule, sans dépendances |
| Configuration | `smol-toml` + zod ; parseurs de durée et d'adresse écrits dans `src/config/` | Node n'a pas de parseur TOML |
| Tests | **vitest**, `fast-check` (propriétés/fuzz), **testcontainers** (vrais clients apt/dnf/apk) | |
| Lint/format | **Biome** + `tsc --noEmit` | Un seul outil |
| Gestionnaire de paquets | **pnpm 10** (scripts d'installation bloqués par défaut, `minimumReleaseAge`) | Chaîne d'approvisionnement |

## Justification

- Déploiement : application = 2 services (`lockmaster` + `clamav` officiel) en conteneur + le serveur de
  dépôt nginx (ADR-0008), ou un paquet
  `.deb/.rpm` + unité systemd (voir ADR-0007). Un fichier de config, un répertoire de données.
- Sécurité : pas d'exécution d'outils système sur du contenu non fiable, pas de shell,
  utilisateur non-root, dépendances peu nombreuses et épinglées (`pnpm audit`, SBOM de l'app).
- Cohérence : la base est **la** source de vérité ; les fichiers publiés sont dérivés et
  régénérables (`lockmaster publish --all`).
- Références de lecture : Gitea implémente nativement des registres Debian/RPM/Alpine (Go,
  licence MIT) ; utile pour comprendre les formats, pas comme dépendance. (Forgejo, fork de Gitea,
  est sous GPL-3.0+ depuis la v9.)

## Alternatives écartées

- **Python simplifié** : connu du porteur, mais packaging .deb/.rpm d'un venv plus délicat.
- **C# / .NET** : excellent candidat (exécutable autonome) ; non retenu par choix du porteur.
- **Garder reprepro/createrepo_c** : c'est précisément la source des incohérences d'état.

## Conséquences

- Tests d'intégration **avec les vrais clients** (`apt`, `dnf`, `apk` en conteneurs)
  obligatoires pour prouver la compatibilité des métadonnées (`docs/10-tests.md`).
- Le parsing de formats binaires non fiables doit être testé par propriétés/fuzzing et
  borné en taille, en profondeur et en temps (`docs/02-securite.md`).
- `better-sqlite3` est le seul module natif : prébuilds par architecture (x64/arm64,
  glibc/musl) gérés dans le packaging. Bascule possible vers `node:sqlite` quand il sera stable.
