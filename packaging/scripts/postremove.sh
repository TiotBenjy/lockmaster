#!/bin/sh
# postremove de lockmaster. Ne supprime JAMAIS les données ni les clés (ADR-0007) : bases, journaux
# de signature et clés maîtresses restent en place, même après une purge.
set -e

if [ -d /run/systemd/system ]; then
  systemctl daemon-reload || true
fi

case "${1-}" in
  purge | 0)
    cat <<'MSG'
lockmaster est supprimé. Données et clés conservées, à supprimer à la main si besoin :
  /var/lib/lockmaster, /var/lib/lockmaster-signer, /etc/lockmaster, /etc/lockmaster-signer.
Comptes lockmaster, lockmaster-signer et groupe lockmaster-sign conservés.
MSG
    ;;
esac
