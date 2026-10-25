#!/bin/sh
# postremove de lockmaster-repo (.deb « remove », « purge »... ; .rpm 0 ou 1). Les dépôts publiés
# (/srv/lockmaster-repo), le compte lockmaster-sync et ses clés autorisées sont conservés.
set -e

case "${1-}" in
  purge | 0) ;;
  *) exit 0 ;;
esac

if command -v semanage >/dev/null 2>&1; then
  semanage fcontext -d '/srv/lockmaster-repo(/.*)?' 2>/dev/null || true
fi

cat <<'MSG'
lockmaster-repo est supprimé. Conservés, à supprimer à la main si besoin : /srv/lockmaster-repo,
/home/lockmaster-sync, le compte lockmaster-sync et le groupe lockmaster-repo.
MSG
