# Quadlets Podman rootless : deux comptes de service (ADR-0009)

L'application et le service de signature tournent sous **deux comptes Linux distincts**, chacun avec
son Podman rootless. Ils ne partagent qu'un dossier hôte contenant le socket de signature.

```
compte lockmaster          : lockmaster.container, clamav.container, repo.container, lockmaster.network, *.volume
compte lockmaster-signer   : lockmaster-signer.container, lockmaster-signer-keys.volume
partagé               : /run/lockmaster-sign/sign.sock (groupe hôte lockmaster-sign)
```

## Préparation de l'hôte (root, une fois)

```bash
# Comptes et groupe : mêmes définitions que les paquets (packaging/sysusers/lockmaster.conf)
systemd-sysusers ./packaging/sysusers/lockmaster.conf
# Plages subuid/subgid (non créées pour les comptes système) : choisir des plages libres
usermod --add-subuids 200000-265535 --add-subgids 200000-265535 lockmaster
usermod --add-subuids 300000-365535 --add-subgids 300000-365535 lockmaster-signer
# Les services démarrent sans session ouverte
loginctl enable-linger lockmaster lockmaster-signer
# Dossier du socket (2750 lockmaster-signer:lockmaster-sign, setgid), recréé à chaque démarrage
install -m 0644 ./packaging/tmpfiles/lockmaster.conf /etc/tmpfiles.d/lockmaster.conf
systemd-tmpfiles --create /etc/tmpfiles.d/lockmaster.conf
# SELinux (RHEL/Fedora) : le dossier partagé doit être accessible aux conteneurs
semanage fcontext -a -t container_file_t '/run/lockmaster-sign(/.*)?' && restorecon -Rv /run/lockmaster-sign
```

Vérifier que le runtime est **crun** pour le compte `lockmaster` (requis par `--group-add keep-groups`) :
`sudo -u lockmaster podman info --format '{{.Host.OCIRuntime.Name}}'`.

## Installation des quadlets

```bash
# Signataire
sudo -u lockmaster-signer mkdir -p ~lockmaster-signer/.config/containers/systemd
sudo install -o lockmaster-signer -m 0644 lockmaster-signer/* ~lockmaster-signer/.config/containers/systemd/
# Clé maîtresse du signataire : secret Podman du compte lockmaster-signer UNIQUEMENT
sudo -u lockmaster-signer sh -c 'podman run --rm --network none ghcr.io/tiotbenjy/lockmaster:1 keys gen-master | podman secret create lockmaster-signer-master-key -'

# Application
sudo -u lockmaster mkdir -p ~lockmaster/.config/containers/systemd
sudo install -o lockmaster -m 0644 lockmaster/* ~lockmaster/.config/containers/systemd/
sudo -u lockmaster sh -c 'podman run --rm --network none ghcr.io/tiotbenjy/lockmaster:1 keys gen-master | podman secret create lockmaster-master-key -'

# Initialisation (signataire d'abord), puis démarrage
sudo -u lockmaster-signer podman run --rm --network none --userns keep-id:uid=10002,gid=10100 \
  -v lockmaster-signer-keys:/var/lib/lockmaster-signer --secret lockmaster-signer-master-key,type=mount,target=/run/secrets/master_key,uid=10002,gid=10100,mode=0400 \
  -e LOCKMASTER_SIGNER__SECURITY__MASTER_KEY_FILE=/run/secrets/master_key \
  ghcr.io/tiotbenjy/lockmaster:1 signer init
sudo -u lockmaster-signer XDG_RUNTIME_DIR=/run/user/$(id -u lockmaster-signer) systemctl --user daemon-reload
sudo -u lockmaster-signer XDG_RUNTIME_DIR=/run/user/$(id -u lockmaster-signer) systemctl --user start lockmaster-signer
sudo -u lockmaster XDG_RUNTIME_DIR=/run/user/$(id -u lockmaster) systemctl --user daemon-reload
# (init de l'application : voir docs/08 §3, puis)
sudo -u lockmaster XDG_RUNTIME_DIR=/run/user/$(id -u lockmaster) systemctl --user start lockmaster clamav repo
```

## Ce que chaque compte peut faire

| | compte `lockmaster` | compte `lockmaster-signer` |
|---|---|---|
| Réseau | oui (admin, amont, cibles) | **aucun** (`Network=none`) |
| Clés de signature privées | **non** | oui (volume + secret propres) |
| Socket `/run/lockmaster-sign/sign.sock` | se connecte (groupe `lockmaster-sign`) | l'écoute |
| Évasion de son conteneur | donne le compte hôte `lockmaster`, qui ne peut pas lire les fichiers ni le stockage Podman de `lockmaster-signer` | - |

Le port 443 n'est pas accessible à un compte non privilégié : `repo.container` publie 8443/8081
(8080 est pris par l'application sur 127.0.0.1) ;
rediriger 443 -> 8443 au pare-feu, ou abaisser `net.ipv4.ip_unprivileged_port_start`.
