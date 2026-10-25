#!/bin/sh
# Génère deploy/nginx/lockmaster-repo.container.conf à partir de la configuration de référence
# deploy/nginx/lockmaster-repo.conf, pour l'image nginx non-root (pas de port < 1024, rootfs en
# lecture seule). La CI exécute ce script et échoue si le fichier commité diffère (git diff).
set -eu
src="$(dirname "$0")/../deploy/nginx/lockmaster-repo.conf"
dst="$(dirname "$0")/../deploy/nginx/lockmaster-repo.container.conf"
{
  echo "# FICHIER GÉNÉRÉ par packaging/gen-nginx-container-conf.sh depuis lockmaster-repo.conf : ne pas éditer."
  sed \
    -e 's#listen 443 ssl http2;#listen 8443 ssl http2;#' \
    -e 's#listen \[::\]:443 ssl http2;#listen [::]:8443 ssl http2;#' \
    -e 's#listen 80;#listen 8080;#' \
    -e 's#listen \[::\]:80;#listen [::]:8080;#' \
    -e 's#access_log /var/log/nginx/lockmaster-repo.access.log lockmaster_json;#access_log /dev/stdout lockmaster_json;#' \
    "$src"
} > "$dst"
for pattern in 'listen 8443 ssl http2;' 'listen 8080;' 'access_log /dev/stdout lockmaster_json;'; do
  grep -qF "$pattern" "$dst" || { echo "gen-nginx-container-conf: motif absent : $pattern" >&2; exit 1; }
done
