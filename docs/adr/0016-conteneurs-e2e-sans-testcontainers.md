# ADR-0016 : Conteneurs des tests e2e pilotés par la CLI, sans testcontainers

- Statut : proposé
- Date : 2026-10-26
- Modifie ADR-0001 (ligne « Tests » : testcontainers)

## Contexte

ADR-0001 et `docs/10` prévoient testcontainers pour les tests e2e (vrais clients apt, dnf, apk,
clamd, nginx). Le premier test e2e (M1 : versions et parseurs confrontés à dpkg, rpm, apk) a voulu
l'ajouter, avec l'accord du porteur. `pnpm add -D testcontainers` (12.2.1) échoue :

- 150 paquets ajoutés à l'arbre de développement ;
- trois d'entre eux ont un script d'installation : `cpu-features` (compilation native facultative
  pour `ssh2`), `ssh2` et `protobufjs`. La liste fermée `allowBuilds` de `pnpm-workspace.yaml`
  (SEC-24) les refuse et pnpm s'arrête (`ERR_PNPM_IGNORED_BUILDS`).

CLAUDE.md interdit tout paquet à script d'installation hors de cette liste, et la liste ne s'étend
qu'en passant par le test SEC-24 (`test/security/`, protégé).

## Décision

Les tests e2e pilotent les conteneurs par la CLI du moteur (`test/e2e/support/containers.ts`) :

- moteur : `LOCKMASTER_E2E_ENGINE`, sinon `podman`, sinon `docker` ;
- `execFile` sans shell côté hôte, délai borné, données passées par stdin, fichiers relus en base64 ;
- images épinglées par digest dans `packaging/versions.env` (`update-pins.sh`), comme les tests de
  livrables (`test/deliverables/`) : `DEBIAN_12`, `DEBIAN_13`, `ROCKY_9`, `ROCKY_10`, et désormais
  `ALPINE_3_20` (plancher, apk-tools 2.14.4) et `ALPINE_3_22` (maintenue, apk-tools 2.14.12) ;
- chaque conteneur est arrêté par `afterAll` (`rm -f`).

Les besoins à venir (réseaux, volumes partagés pour nginx, attente d'un port) s'ajoutent à ce module
quand un jalon en a besoin (M3, M4).

## Justification

- Aucune dépendance ajoutée, aucun script d'installation, aucune exception à `allowBuilds`.
- Même approche que `test/deliverables/` (déjà en CI avec Podman rootless et Docker).
- Le module fait une soixantaine de lignes ; testcontainers apporterait surtout la gestion de cycle de
  vie (Ryuk), dont la configuration sous Podman rootless est elle-même un point de friction (`docs/10`).

## Alternatives écartées

- testcontainers avec les trois scripts autorisés : élargit `allowBuilds` à du code natif (`cpu-features`)
  pour un besoin de test ; contraire à SEC-24.
- testcontainers avec les trois scripts explicitement refusés (`allowBuilds: { ssh2: false, ... }`) :
  l'installation passe et `ssh2` fonctionne sans `cpu-features`, mais 150 paquets entrent dans l'arbre
  de développement (exposés à `pnpm audit` et aux mises à jour) et la liste fermée de réglages de
  `pnpm-workspace.yaml` change. Reste possible si le besoin apparaît (M3, M4), par un nouvel ADR.
- `dockerode` seul : même chaîne de dépendances (`ssh2`, `cpu-features`).

## Conséquences

- CLAUDE.md (stack, commandes), ADR-0001, `docs/10` et la feuille de route (M4 : clamd « via
  testcontainers ») sont mis à jour : e2e par la CLI Podman ou Docker.
- `.claude/agents/test-engineer.md` mentionne encore testcontainers : à corriger par le porteur
  (dossier `.claude/` protégé).
- Les paquets réels amont (Debian, Rocky, Alpine) sont téléchargés dans les conteneurs jetables par
  leur gestionnaire de paquets, jamais commités : apt et apk vérifient la signature de l'index puis
  l'empreinte du paquet ; dnf vérifie l'empreinte contre des métadonnées obtenues en HTTPS, sans
  signature (`repo_gpgcheck` désactivé par défaut sur Rocky). Ce sont des données de test : le test
  les passe à nos parseurs et compare le résultat aux outils de la distribution.
