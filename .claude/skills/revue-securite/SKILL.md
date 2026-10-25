---
description: Lance une revue de sécurité indépendante (agent security-reviewer) sur le diff courant, des fichiers, un jalon, ou tout le projet.
argument-hint: "[fichiers | Mn | all] (défaut : diff courant)"
disable-model-invocation: true
---

# Revue de sécurité

Périmètre : `$ARGUMENTS` (vide = changements non fusionnés : `git diff --merge-base origin/main` + non commités).

1. Détermine la liste exacte des fichiers concernés. Pour `all`, découpe par domaine
   (`formats`, `crypto`+`auth`, `pipeline`+`scan`, `upstream`+`net`, `publish`+`storage`+`stats`,
   `http`+`web`, `packaging`+`deploy` dont `deploy/nginx/`) et lance **un agent `security-reviewer` par domaine en parallèle**.
2. Transmets à chaque agent : le périmètre, le jalon en cours, et la consigne de suivre son format
   de rapport. Ne lui transmets pas ton propre avis sur le code (relecture indépendante).
3. Consolide les rapports : dédoublonne, trie par gravité (BLOQUANT > IMPORTANT > MINEUR),
   garde les références `fichier:ligne` et les scénarios.
4. Pour chaque constat BLOQUANT ou IMPORTANT, propose la correction minimale et le test qui
   l'aurait détecté. Ne corrige pas sans accord si l'utilisateur n'a pas demandé de correction.
5. Rends le verdict global et la liste priorisée.
