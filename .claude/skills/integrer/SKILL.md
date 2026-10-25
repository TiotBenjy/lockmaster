---
description: Intègre le worktree courant dans sa branche source - mise à jour depuis la source, vérifications, revue de sécurité, sortie du worktree, merge --ff-only dans le checkout principal, nettoyage. À utiliser quand une tâche (feature, fix, refactor...) faite dans un worktree est terminée.
argument-hint: "(aucun : agit sur le worktree courant)"
---

# Intégrer un worktree dans sa branche source

Règles : `CLAUDE.md` §Flux git. Aucun push : l'utilisateur pousse lui-même.

## 1. Dans le worktree
1. Vérifie que tu es dans un worktree `worktree-<type>-<sujet>` et lis sa branche source :
   `git config --get branch.$(git branch --show-current).claudesource`.
2. Tout est commité (`git status` propre) ; sinon, committe (commits conventionnels en français).
3. Récupère la source : `git merge <source>`. En cas de conflit, résous-le **dans le worktree**,
   relance les tests, committe la résolution.
4. Vérifications : `pnpm check`, `pnpm test`, et `pnpm test:e2e` si la tâche touche formats,
   publication, import, signature ou livraison (demande l'autorisation pour les conteneurs).
5. Zone sensible modifiée (voir CLAUDE.md §Méthode, point 4) -> agent `security-reviewer` sur
   `git diff <source>...HEAD`. Corrige tout constat BLOQUANT ou IMPORTANT, puis reviens à l'étape 4.
6. Vérifie le TDD : chaque comportement ajouté ou corrigé a son test (`git diff <source>...HEAD --stat`).

## 2. Sortir et intégrer
7. `ExitWorktree` (garde le worktree sur le disque).
8. Dans le checkout principal, vérifie qu'il est **sur la branche source** (`git branch --show-current`).
   S'il est sur une autre branche, **arrête-toi** et demande à l'utilisateur : tu ne changes jamais
   la branche du checkout principal.
9. `git merge --ff-only worktree-<type>-<sujet>`. Si l'avance rapide est impossible (la source a
   bougé), retourne dans le worktree (`EnterWorktree`) et reprends à l'étape 3.
10. Nettoyage : `git worktree remove .claude/worktrees/<type>-<sujet>` puis
    `git branch -d worktree-<type>-<sujet>`.

## 3. Rendre compte
Résumé : branche intégrée, commits (`git log --oneline <ancien-sommet>..HEAD`), tests passés, revue
de sécurité, et rappel que rien n'a été poussé.
