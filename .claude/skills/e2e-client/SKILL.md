---
description: Vérifie qu'un dépôt publié par Lockmaster et servi par nginx fonctionne avec les vrais clients apt, dnf ou apk dans des conteneurs (Docker ou Podman), et diagnostique les erreurs client.
argument-hint: "[apt|dnf|apk|all]"
---

# Test avec les vrais clients

Clients : `$ARGUMENTS` (défaut `all`).

1. Vérifie la présence d'un moteur de conteneurs (`docker info` ou `podman info`) ; pour Podman,
   utiliser le socket (`systemctl --user start podman.socket`, `DOCKER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock`,
   `TESTCONTAINERS_RYUK_DISABLED=true`). Demande l'autorisation avant de lancer des conteneurs.
2. Lance la suite ciblée : `pnpm test:e2e -t "<client>"`. Distributions minimales :
   apt -> `debian:12`, `debian:13` ; dnf -> `rockylinux:9`, `rockylinux/rockylinux:10` ;
   apk -> `alpine:3.20` et la dernière stable.
3. Topologie : application Lockmaster + conteneur nginx `repo` (config `deploy/nginx/lockmaster-repo.conf`,
   volume partagé en lecture seule) ; les clients ne joignent **que** nginx.
   Chaque scénario : installation de la clé publique depuis `/keys/` sur nginx, configuration du dépôt telle
   que la donne `GET /api/v1/repos/:repo/client-setup`, `update`, installation d'un paquet,
   vérification de signature (`gpgv`/`rpm -K`/`apk verify`), et pour APT une republication
   pendant `apt update` en boucle (aucun « Hash Sum mismatch »).
4. En cas d'échec : récupère la sortie complète du client et les métadonnées servies
   (`curl` depuis le conteneur, en-têtes compris) et les journaux nginx, puis délègue le diagnostic à l'agent `formats-expert`
   avec ces éléments.
5. Rends compte : matrice client x distribution x résultat, et causes des échecs.
