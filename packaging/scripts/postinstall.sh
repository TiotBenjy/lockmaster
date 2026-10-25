#!/bin/sh
# postinstall de lockmaster. Arguments : .deb « configure [ancienne version] », .rpm 1 (installation)
# ou 2 (mise à jour). Idempotent ; ne démarre aucun service, ne génère aucun secret (ADR-0007).
set -e

case "${1-}" in
  configure) upgrade=${2:+yes} ;;
  1) upgrade= ;;
  2) upgrade=yes ;;
  *) exit 0 ;;
esac

systemd-sysusers /usr/lib/sysusers.d/lockmaster.conf
systemd-tmpfiles --create /usr/lib/tmpfiles.d/lockmaster.conf

# Configuration lisible par le seul groupe du service concerné (livrée en root:root).
chgrp lockmaster /etc/lockmaster /etc/lockmaster/lockmaster.toml
chgrp lockmaster-signer /etc/lockmaster-signer /etc/lockmaster-signer/signer.toml
chmod 0750 /etc/lockmaster /etc/lockmaster-signer
chmod 0640 /etc/lockmaster/lockmaster.toml /etc/lockmaster-signer/signer.toml

if [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  # Mise à jour : seuls les services déjà actifs sont relancés, rien n'est démarré.
  [ -z "$upgrade" ] || systemctl try-restart lockmaster-signer.service lockmaster.service || true
fi

if [ -z "$upgrade" ]; then
  cat <<'MSG'
lockmaster est installé mais pas démarré. Étapes suivantes :
  sudo lockmaster init
  sudo systemctl enable --now lockmaster-signer.socket lockmaster
Configuration : /etc/lockmaster/lockmaster.toml (application), /etc/lockmaster-signer/signer.toml
(service de signature). Documentation : /usr/share/doc/lockmaster/.
MSG
fi
