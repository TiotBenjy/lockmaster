# Installation

Lockmaster s'installe en paquet `.deb` ou `.rpm` avec systemd, ou en conteneurs (Docker ou Podman).
Distributions supportées : Debian 12 et 13, Rocky Linux 9 et 10 (et RHEL ou AlmaLinux 9 et 10).
Procédures détaillées, sauvegarde et exploitation : `docs/08-exploitation.md`.

Ce guide couvre le jalon M0 : le service démarre et répond sur `/healthz`. Le premier compte
administrateur, les clés de signature des dépôts et la publication arrivent avec les jalons suivants.

## Paquets (.deb, .rpm)

```bash
sudo apt install ./lockmaster_X.Y.Z-1_amd64.deb          # Debian
sudo dnf install ./lockmaster-X.Y.Z-1.x86_64.rpm         # Rocky, RHEL, AlmaLinux
sudo lockmaster init --non-interactive --admin-password-file /chemin/mot-de-passe
sudo systemctl enable --now lockmaster-signer.socket lockmaster
curl -f http://127.0.0.1:8080/healthz                    # « ok »
```

- L'installation crée les comptes `lockmaster` et `lockmaster-signer` et le groupe `lockmaster-sign`.
  Elle ne démarre rien et ne crée aucune clé.
- `lockmaster init` crée la clé maîtresse (`/etc/lockmaster/master.key`, lisible par root seul : le
  service la reçoit de systemd) et la base. Pour chiffrer la clé avec `systemd-creds` :
  `/usr/share/doc/lockmaster/examples/master-key-credential.conf`.
- Configuration : `/etc/lockmaster/lockmaster.toml` (application), `/etc/lockmaster-signer/signer.toml`
  (service de signature).
- Tant que `init` n'a pas été exécuté, `lockmaster serve` s'arrête avec le code 78 et le message
  « exécuter lockmaster init ».

## Serveur de dépôt (paquet lockmaster-repo)

```bash
sudo apt install ./lockmaster-repo_X.Y.Z-1_all.deb       # ou dnf install ./lockmaster-repo-X.Y.Z-1.noarch.rpm
# certificat TLS dans /etc/nginx/tls/repo.crt et /etc/nginx/tls/repo.key, puis :
sudoedit /etc/nginx/conf.d/lockmaster-repo.conf          # server_name, adresse syslog
sudo nginx -t && sudo systemctl reload nginx
```

## Conteneurs

- **compose** (Docker ou Podman, un seul compte) : `deploy/compose.yaml`, procédure complète dans
  `docs/08-exploitation.md` §3.2 (secrets, `signer init`, `init`, démarrage).
- **Podman rootless, deux comptes** (séparation du signataire par compte Linux, recommandé en
  conteneur) : `deploy/quadlet/README.md`.

## Vérifier un livrable

Les tests de livrables de la CI se lancent aussi en local, avec Podman (et Docker pour l'image),
après `pnpm package` et `pnpm image` :

```bash
sh test/deliverables/packages.sh DEBIAN_12       # ou DEBIAN_13, ROCKY_9, ROCKY_10
sh test/deliverables/repo-package.sh ROCKY_9
sh test/deliverables/image.sh podman             # ou docker
```
