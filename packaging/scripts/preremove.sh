#!/bin/sh
# preremove de lockmaster. Arguments : .deb « remove », « upgrade »... ; .rpm 0 (suppression) ou
# 1 (mise à jour). Arrête et désactive les services à la suppression seulement.
set -e

case "${1-}" in
  remove | 0) ;;
  *) exit 0 ;;
esac

units='lockmaster.service lockmaster-signer.service lockmaster-signer.socket'
if [ -d /run/systemd/system ]; then
  # shellcheck disable=SC2086
  systemctl disable --now $units || true
elif command -v systemctl >/dev/null 2>&1; then
  # shellcheck disable=SC2086
  systemctl disable $units || true
fi
