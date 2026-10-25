---
paths:
  - "packaging/**"
  - "deploy/**"
  - "src/publish/targets/**"
  - ".github/workflows/**"
---

# Règles pour la livraison

- Référence : `docs/adr/0007-livraison-deb-rpm-oci.md` et `docs/08-exploitation.md` ; agent
  `packaging-engineer` pour les changements non triviaux.
- Toutes les versions d'outils et binaires externes (Node, Grype, nfpm, images de base) sont
  épinglées dans `packaging/versions.env` avec leur SHA-256 ; vérification obligatoire au build.
  Jamais `curl | sh`, jamais de tag `latest`.
- Actions GitHub épinglées par SHA de commit ; `permissions:` minimales par job.
- Les trois livrables de l'application (.deb, .rpm, image) restent fonctionnellement identiques ;
  un changement dans l'un est répercuté et testé dans les autres (Docker **et** Podman).
- Serveur de dépôt : `deploy/nginx/lockmaster-repo.conf` est la référence unique (paquet `lockmaster-repo` et
  service `repo` l'utilisent) ; tout changement passe `nginx -t` et la suite e2e. Aucun code Lockmaster,
  aucune clé, aucune base sur le serveur de dépôt.
- Scripts de maintenance POSIX sh, idempotents, sans génération de secret, sans suppression de
  `/var/lib/lockmaster`.
