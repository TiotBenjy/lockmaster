---
description: Implémente le prochain jalon (ou celui passé en argument) de docs/09-feuille-de-route.md, de la lecture des specs jusqu'aux critères cochés.
argument-hint: "[M0..M10] (optionnel : prochain jalon non terminé)"
disable-model-invocation: true
---

# Implémenter un jalon de Lockmaster

Jalon demandé : `$ARGUMENTS` (vide = le premier jalon de `docs/09-feuille-de-route.md` dont
des cases ne sont pas cochées).

## 1. Préparer
1. Lis le jalon dans `docs/09-feuille-de-route.md` et vérifie que le jalon précédent est entièrement coché.
   Sinon, arrête-toi et dis lesquels de ses critères manquent.
2. Lis `CLAUDE.md`, `docs/01-architecture.md`, `docs/02-securite.md` et les documents du domaine
   (formats -> `03`, pipeline -> `04`, base -> `05`, API -> `06`, UI -> `07` et `12`, livraison -> ADR-0007 et `08`).
3. Ne travaille jamais dans le checkout principal : chaque tâche du jalon aura son worktree
   (`CLAUDE.md` §Flux git).

## 2. Planifier (court, dans la conversation)
- Liste des fichiers à créer/modifier, des tests à écrire, des dépendances npm éventuelles
  (chacune justifiée selon CLAUDE.md), et des points de spécification à vérifier dans les sources
  officielles. Crée une tâche par critère d'acceptation.
- Si une décision d'architecture n'est pas couverte par un ADR, propose un ADR (`/adr`) avant de coder.

## 3. Réaliser, tâche par tâche (un worktree par tâche)
- Pour chaque tâche : `EnterWorktree` avec un nom `<type>-m<N>-<sujet>` (ex. `feat-m3-publication-apt`),
  `pnpm install`, puis **TDD** : test qui échoue -> code minimal -> refactor (agent `test-engineer` si utile).
- Concevoir par interfaces (SOLID, `CLAUDE.md` §SOLID) : nouvelle implémentation d'une interface =
  passer sa suite de conformité `test/contracts/`.
- Tâche terminée : `/integrer` (merge `--ff-only` dans la branche source), puis tâche suivante.
- Détails de format : délègue à l'agent `formats-expert` en cas de doute ; jamais de mémoire.
- Livraison (`packaging/`, `deploy/`, CI) : agent `packaging-engineer`.
- Écrans : `docs/12-systeme-de-design.md` et `.claude/rules/ui.md` font foi ; le skill
  `ui-ux-pro-max` sert aux questions UX ciblées (`--domain ux`) ; avant d'intégrer, passer la liste
  de contrôle de `docs/12` §12 (Playwright + axe, zéro violation CSP).
- Après chaque critère : `pnpm check && pnpm test` ; e2e ciblé dès que des métadonnées de dépôt changent.

## 4. Vérifier
1. `pnpm check && pnpm test` verts ; `pnpm test:e2e` si le jalon touche formats, publication,
   import ou livraison (demander l'autorisation de lancer des conteneurs si nécessaire).
2. Lance l'agent `security-reviewer` sur le diff du jalon. Corrige tout constat BLOQUANT ou IMPORTANT,
   puis relance-le jusqu'à verdict OK ou À CORRIGER (mineurs listés).
3. Coche les critères réellement atteints dans `docs/09-feuille-de-route.md`. Un critère non atteint
   reste décoché avec une note expliquant pourquoi.

## 5. Rendre compte
Résumé en français : critères atteints, écarts, constats de sécurité restants, prochaine étape.
Les commits sont locaux et déjà intégrés dans la branche source ; rappelle que rien n'a été poussé.
