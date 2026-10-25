# ADR-0002 : SQLite (WAL) comme unique source de vérité

- Statut : accepté
- Date : 2026-10-19

## Contexte

Répartir l'état entre une base serveur, des fichiers de réglages, des manifestes JSON, la base
interne d'un outil comme reprepro, des journaux d'audit en fichiers, des jetons sur disque et un
ordonnanceur en mémoire produit des désynchronisations (piège R1) : suppression qui laisse une ligne en base, fichiers orphelins dans le stock, etc.

## Décision

- **SQLite en mode WAL** via `better-sqlite3` (synchrone, rapide, transactions simples),
  requêtes typées avec **Kysely** (`SqliteDialect`). Pas d'ORM à entités/relations implicites.
- Toute donnée d'état vit dans `data/lockmaster.db` : utilisateurs, sessions, jetons, paquets,
  résultats de scan, décisions, politique, réglages, journal d'audit chaîné, jobs.
- Les binaires de paquets vivent dans un **magasin adressé par contenu**
  `data/blobs/sha256/ab/cd/<sha256>` (écriture dans `data/tmp`, `fsync`, `rename`).
- L'arborescence publiée sur les cibles (serveur de dépôt nginx, ADR-0008) est **dérivée** :
  régénérable à tout moment par `lockmaster publish --all`.
- Migrations : fichiers `src/db/migrations/NNNN_nom.sql`, **embarqués dans le bundle** par
  esbuild (loader `text` pour `.sql`), appliqués au démarrage, version suivie par
  `PRAGMA user_version`. Règle unique : **une migration déjà commitée sur la branche principale
  n'est jamais modifiée** ; tout changement passe par une nouvelle migration. Les migrations qui
  reconstruisent une table désactivent `foreign_keys` **hors** transaction (le pragma est sans
  effet dans une transaction), puis vérifient `PRAGMA foreign_key_check` avant de le réactiver.
- Types : dates en `INTEGER` (ms Unix UTC), booléens `INTEGER` 0/1 avec `CHECK`,
  JSON en `TEXT` avec `CHECK (json_valid(col))` seulement quand une table dédiée ne convient pas.
- Pragmas à l'ouverture : `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`,
  `synchronous=NORMAL`, `trusted_schema=OFF`.
- `better-sqlite3` étant synchrone, toute requête doit rester courte (< 10 ms visés) ;
  les traitements lourds (scan, génération de métadonnées) lisent par pages et écrivent
  par lots, jamais une transaction ouverte pendant une I/O réseau ou un scan.

## Justification

- Un fichier = une sauvegarde (`db.backup()` / `VACUUM INTO` à chaud), restauration triviale.
- Volume visé : jusqu'à ~10⁶ lignes de paquets et quelques écritures/seconde -> largement
  dans les capacités de SQLite.
- Supprime un conteneur, un mot de passe, une dépendance réseau, une classe de pannes.

## Haute disponibilité

Pas de HA active-active en v1 (piège R3).
Équivalent : sauvegarde continue (Litestream ou `lockmaster backup` planifié) de la base + réplication
des blobs (rsync / stockage objet) + bascule manuelle documentée. Les accès aux données passent
par des *repositories* TS (`src/db/repos/*.ts`) : un backend PostgreSQL resterait possible
**si** un besoin réel apparaît (Kysely supporte les deux dialectes).

## Conséquences

- Un seul processus écrit dans la base : plus de verrous applicatifs ad hoc ni d'élection
  de leader (`import_lock.py`, `leader_election.py` disparaissent).
- Le processus refuse de démarrer si un autre `lockmaster` utilise déjà le répertoire de données :
  il ouvre `data/lockmaster.lock` comme seconde base SQLite avec `PRAGMA locking_mode=EXCLUSIVE` et
  y prend un verrou d'écriture conservé toute la vie du processus (verrou du système
  d'exploitation, libéré automatiquement à la mort du processus). Aucun module natif
  supplémentaire. Les commandes CLI qui écrivent utilisent le même verrou et refusent de
  s'exécuter pendant que le service tourne, sauf celles qui passent par l'API.
