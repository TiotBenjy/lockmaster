# ADR-0007 : Livraison : paquets .deb / .rpm et image OCI (Docker & Podman)

- Statut : accepté, complété par ADR-0008 (livrables du serveur de dépôt)
- Date : 2026-10-19

## Contexte

Un déploiement uniquement en Docker Compose multi-images est lourd à exploiter. Le porteur veut pouvoir
installer Lockmaster **sans conteneur** (.deb / .rpm + systemd) **ou** en conteneur, avec Docker
comme avec Podman (rootless). Les distributions embarquent des versions de Node.js
hétérogènes (Debian 12 : Node 18 ; Rocky 9 : flux de modules), inutilisables comme dépendance.
Distributions supportées : Debian 12 et 13, Rocky/RHEL/Alma 9 et 10 (décision du porteur, 2026-10-25).

## Décision

### Un seul artefact applicatif, trois emballages

`pnpm build` produit `dist/` : l'application compilée et **bundlée avec esbuild** en un
fichier `dist/lockmaster.mjs` (migrations SQL incluses via le loader `text`) + `dist/static/`
(htmx, CSS), plus le seul module natif `better-sqlite3`, déclaré `external` dans esbuild et
copié dans `dist/node_modules/better-sqlite3/` avec le binaire `.node` correspondant à l'ABI de
Node 24, pour chaque cible : linux-x64 et linux-arm64, **glibc >= 2.34** (Rocky/RHEL 9 est la cible la
plus ancienne ; compiler dans un conteneur AlmaLinux 9 si aucun prébuild compatible n'existe).
Cet artefact est emballé de trois façons :

| Livrable | Contenu | Outil |
|---|---|---|
| `.deb` (Debian 12/13) | `/usr/lib/lockmaster/{node,bin,*.mjs,node_modules,static}` + `/usr/bin/lockmaster` + unités systemd + `/etc/lockmaster/lockmaster.toml` (conffile) | **nfpm** (`packaging/nfpm.yaml`) |
| `.rpm` (Rocky/RHEL/Alma 9/10) | idem | **nfpm** (même fichier) |
| Image OCI | base `debian:*-slim` épinglée par digest + Node 24 officiel + app + grype + `rsync` + `openssh-client` (cibles distantes), non-root | `packaging/Containerfile` (Docker **et** Podman/Buildah) |

- Le **runtime Node 24 officiel** (tarball nodejs.org, SHA-256 vérifié contre `SHASUMS256.txt`
  signé) est embarqué dans `/usr/lib/lockmaster/node/` : aucune dépendance au Node de la distribution.
- **Grype** est embarqué (binaire officiel épinglé, SHA-256 vérifié au build).
- **ClamAV** n'est pas embarqué :
  - `.deb` : `Recommends: clamav-daemon` ; `.rpm` : `Recommends: clamd` (EPEL sur RHEL).
    `lockmaster doctor` vérifie la connexion au socket et explique la configuration.
  - Conteneur : image officielle `clamav/clamav` en second service.
- Architectures : `amd64`/`x86_64` et `arm64`/`aarch64`.

### Paquets système

- Comptes et groupe créés par `systemd-sysusers` (`packaging/sysusers/lockmaster.conf`) : `lockmaster`,
  `lockmaster-signer` (ADR-0009) et `lockmaster-sign` ; dossier du socket par `systemd-tmpfiles`
  (`packaging/tmpfiles/lockmaster.conf`).
- Unités de référence : `packaging/systemd/lockmaster.service`, `lockmaster-signer.socket`,
  `lockmaster-signer.service` (validées par `systemd-analyze verify` ; exposition 1,4 et 0,3).
- Paquets : `Depends` ajoute `rsync` et `openssh-client` (.deb) / `openssh-clients` (.rpm) pour les
  cibles distantes.
- Répertoires : `/var/lib/lockmaster` (0750 lockmaster:lockmaster), `/etc/lockmaster` (0750 root:lockmaster),
  `/etc/lockmaster/ssh` (0700 lockmaster:lockmaster, clés de publication rsync et `known_hosts` épinglé),
  logs sur journald (stdout JSON).
- Unité `lockmaster.service` durcie : `NoNewPrivileges=yes`, `ProtectSystem=strict`,
  `ProtectHome=yes`, `PrivateTmp=yes`, `PrivateDevices=yes`, `ReadWritePaths=/var/lib/lockmaster /etc/lockmaster/ssh`
  (+ le `path` de chaque cible `local`, ajouté par `lockmaster init`/`lockmaster targets` dans le drop-in
  `/etc/systemd/system/lockmaster.service.d/targets.conf`),
  `CapabilityBoundingSet=` (vide ; `CAP_NET_BIND_SERVICE` seulement si port < 1024 configuré),
  `SystemCallFilter=@system-service`, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`,
  `MemoryDenyWriteExecute=no` (V8 JIT l'exige : documenté), `UMask=0027`.
- `postinstall` ne démarre pas le service et ne génère aucun secret silencieusement :
  il affiche les 3 commandes d'initialisation (`lockmaster init`, `systemctl enable --now lockmaster`,
  création de l'admin). `preremove` arrête le service ; `purge` ne supprime **jamais**
  `/var/lib/lockmaster` sans action explicite de l'opérateur.
- Le .deb/.rpm de Lockmaster est lui-même publiable dans... Lockmaster (dogfooding, test e2e).

### Conteneurs

- Même image pour l'application et le signataire (`serve` / `signer serve`). Elle contient
  `/run/lockmaster-sign` (10002:10100, 2750), `/var/lib/lockmaster-signer` (10002, 0700) et `/var/lib/lockmaster`
  (10001:10101, 0750), dont héritent les volumes nommés.
- Trois modes (ADR-0009) : quadlets Podman rootless à deux comptes (`deploy/quadlet/`), compose
  (`deploy/compose.yaml`), et paquets.

- `deploy/compose.yaml` : 3 services (`lockmaster`, `clamav`, `repo` = nginx, ADR-0008), 1 réseau interne,
  3 volumes (`lockmaster-data`, `clamav-db`, `repo-public`) ; compatible `docker compose` et
  `podman compose`. Aucun overlay.
- `deploy/quadlet/` : `lockmaster.container`, `clamav.container`, `repo.container`, `lockmaster.network`, `*.volume`
  pour Podman + systemd (rootless supporté).
- Image : utilisateur non-root (UID 10001), système de fichiers racine en lecture seule
  (`read_only: true`), `cap_drop: [ALL]`, `no-new-privileges`, un seul volume `/var/lib/lockmaster`,
  secrets montés en fichiers (`/run/secrets/...`), healthcheck intégré en **forme exec**
  (`["/app/node/bin/node", "/app/lockmaster.mjs", "healthcheck"]`), pas de curl. Pas de socket Docker,
  jamais. Base `debian:*-slim` plutôt que distroless : `rsync` et `ssh` sont nécessaires aux cibles
  distantes ; les trois livrables doivent rester fonctionnellement identiques.
- Même arborescence dans les paquets (`/usr/lib/lockmaster`) et dans l'image (`/app`) : `node/bin/node`,
  `bin/lockmaster` (lanceur sh), `bin/grype`, `lockmaster.mjs`, `lockmaster-signer.mjs` (bundle distinct,
  ADR-0009), `node_modules/better-sqlite3`, `static/`. Le lanceur exécute le Node embarqué sur le bundle
  de l'application, ou sur celui du signataire pour `lockmaster signer ...` ; dans les paquets,
  `/usr/bin/lockmaster` est un lien vers lui. Précision apportée au jalon M0 : la première version de
  cet ADR plaçait le bundle dans un sous-dossier `app/`, absent de l'image. La valeur par défaut de
  `scanners.grype.binary` est déterminée par `lockmaster init` selon l'emballage.
- Signature des images (cosign) et SBOM (CycloneDX) publiés avec chaque version.

### Serveur de dépôt (ADR-0008)

- **Paquet `lockmaster-repo`** (`packaging/nfpm-repo.yaml`, architecture `all`/`noarch`, **aucun code**) :
  `Depends: nginx, rsync` ; installe `/etc/nginx/conf.d/lockmaster-repo.conf` (conffile /
  `%config(noreplace)`), crée `/srv/lockmaster-repo/{public,private}`, le groupe `lockmaster-repo` (avec
  l'utilisateur nginx de la distribution), l'utilisateur `lockmaster-sync` restreint par `rrsync`, et le
  contexte SELinux sur RHEL/Fedora. Ne recharge pas nginx sans l'accord de l'opérateur (affiche
  `nginx -t && systemctl reload nginx`).
- **Conteneur** : image officielle `nginxinc/nginx-unprivileged` (version épinglée) + la config
  montée, volume en lecture seule. Pas d'image Lockmaster spécifique à maintenir.
- La CI teste les deux : `nginx -t` sur la config, installation du paquet sur Debian/Rocky, et les
  e2e clients passent par nginx.

## Conséquences

- La CI construit et **teste les trois livrables** : installation du .deb dans Debian/Ubuntu,
  du .rpm dans Rocky/Fedora, démarrage de l'image sous Docker et Podman, puis le même
  scénario e2e (upload -> scan -> publication -> `apt`/`dnf`/`apk install`).
- nfpm et esbuild sont des outils de build uniquement (non livrés).
