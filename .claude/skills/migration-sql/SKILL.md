---
description: Ajoute une migration SQLite à Lockmaster (nouveau fichier numéroté, types, contraintes, repositories Kysely et tests) sans modifier une migration déjà fusionnée.
argument-hint: "<description du changement de schéma>"
---

# Nouvelle migration SQLite

Changement : `$ARGUMENTS`

1. Lis `docs/05-modele-de-donnees.md` et `src/db/migrations/`. Prends le numéro suivant.
2. **Ne modifie jamais** une migration déjà commitée sur la branche principale (règle d'ADR-0002) :
   crée `src/db/migrations/NNNN_<slug>.sql`. Une migration encore non fusionnée de la branche en
   cours peut être corrigée.
3. Conventions : ms UTC en `INTEGER`, booléens `INTEGER` + `CHECK (x IN (0,1))`, énumérations par
   `CHECK (col IN (...))`, JSON seulement avec `CHECK (json_valid(col))`, clés étrangères explicites
   avec `ON DELETE` choisi consciemment, index pour chaque requête de liste. Pour changer une
   colonne : procédure SQLite en 12 étapes (nouvelle table + copie + `DROP` + `RENAME`). `PRAGMA foreign_keys`
   est sans effet dans une transaction : la migration déclare `-- lockmaster:foreign_keys=off` en tête,
   le moteur de migration désactive alors les clés étrangères **avant** d'ouvrir la transaction,
   exécute `PRAGMA foreign_key_check` avant `COMMIT` (échec = `ROLLBACK`), puis les réactive. Les tables `audit_event` restent append-only (triggers conservés).
4. Mets à jour les types Kysely (`src/db/schema.ts`) et les repositories concernés.
5. Tests : migration appliquée sur une base vide **et** sur une base au schéma précédent remplie
   de données de test ; vérifie `PRAGMA foreign_key_check` et `PRAGMA integrity_check`.
6. Mets à jour `docs/05-modele-de-donnees.md`.
