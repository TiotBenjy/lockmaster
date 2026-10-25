#!/bin/sh
# postinstall de lockmaster-repo (.deb « configure [ancienne version] », .rpm 1 ou 2), ADR-0008 et
# docs/08 §2.1. Idempotent : ne modifie jamais un répertoire ou un fichier existant, ne recharge pas
# nginx, ne génère aucun secret.
set -e

case "${1-}" in
  configure) first=${2:-yes} ;;
  1) first=yes ;;
  2) first= ;;
  *) exit 0 ;;
esac
[ "$first" = yes ] || first=

root=/srv/lockmaster-repo
home=/home/lockmaster-sync

warn() {
  echo "lockmaster-repo : AVERTISSEMENT : $*" >&2
}

systemd-sysusers /usr/lib/sysusers.d/lockmaster-repo.conf

# nginx lit l'arborescence par le groupe lockmaster-repo (www-data : Debian ; nginx : RHEL).
for user in www-data nginx; do
  if id -u "$user" >/dev/null 2>&1; then usermod -a -G lockmaster-repo "$user"; fi
done

# Publieur : l'application si elle est sur cet hôte (cible « local »), sinon le compte rsync.
owner=lockmaster-sync
if id -u lockmaster >/dev/null 2>&1; then
  owner=lockmaster
  usermod -a -G lockmaster-repo lockmaster
fi

# Répertoires 0750 setgid (fichiers publiés en 0640) : nginx lit par le groupe, n'écrit rien.
for dir in "$root" "$root/public" "$root/private"; do
  [ -e "$dir" ] || install -d -m 2750 -o "$owner" -g lockmaster-repo "$dir"
done

# Compte rsync : home et authorized_keys à root (le compte ne peut pas ajouter de clé), lisibles
# par son seul groupe. Chaque clé doit être restreinte par rrsync à la racine du dépôt.
rrsync=
for candidate in /usr/bin/rrsync /usr/share/rsync/scripts/rrsync /usr/libexec/rsync/rrsync; do
  if [ -x "$candidate" ]; then
    rrsync=$candidate
    break
  fi
done
[ -e "$home" ] || install -d -m 0750 -o root -g lockmaster-sync "$home"
[ -e "$home/.ssh" ] || install -d -m 0750 -o root -g lockmaster-sync "$home/.ssh"
if [ ! -e "$home/.ssh/authorized_keys" ]; then
  {
    echo "# Clés de publication de lockmaster (cible rsync), une par ligne, toujours avec la restriction :"
    echo "# command=\"${rrsync:-rrsync} $root\",restrict ssh-ed25519 AAAA... lockmaster@hote-application"
  } >"$home/.ssh/authorized_keys"
  chown root:lockmaster-sync "$home/.ssh/authorized_keys"
  chmod 0640 "$home/.ssh/authorized_keys"
fi
[ -n "$rrsync" ] || warn "rrsync introuvable : la cible rsync ne fonctionnera pas sans lui (voir docs/08 §2.2)"

# Barrière contre les liens symboliques (docs/02) : rien de lockmaster ne doit être lisible par nginx.
repo_gid=$(getent group lockmaster-repo | cut -d: -f3)
for path in /var/lib/lockmaster /etc/lockmaster "$home"; do
  [ -e "$path" ] || continue
  rights=$(stat -c '%A' "$path")
  if [ "$(echo "$rights" | cut -c8)" = r ] ||
    { [ "$(stat -c '%g' "$path")" = "$repo_gid" ] && [ "$(echo "$rights" | cut -c5)" = r ]; }; then
    warn "$path est lisible par nginx (groupe lockmaster-repo ou « others ») : corriger ses droits"
  fi
done

# SELinux (RHEL et dérivés) : contenu web en lecture, aucun booléen à relâcher.
if command -v semanage >/dev/null 2>&1; then
  if semanage fcontext -a -t httpd_sys_content_t "$root(/.*)?" 2>/dev/null ||
    semanage fcontext -m -t httpd_sys_content_t "$root(/.*)?"; then
    restorecon -R "$root" || warn "restorecon a échoué sur $root"
  else
    warn "contexte SELinux non posé : semanage fcontext -a -t httpd_sys_content_t '$root(/.*)?'"
  fi
fi

[ -e /etc/nginx/tls ] || install -d -m 0700 /etc/nginx/tls

if [ -n "$first" ]; then
  cat <<'MSG'
lockmaster-repo est installé ; nginx n'a pas été rechargé. Étapes suivantes :
  1. certificat TLS dans /etc/nginx/tls/repo.crt et /etc/nginx/tls/repo.key ;
  2. sudoedit /etc/nginx/conf.d/lockmaster-repo.conf  (server_name, adresse syslog) ;
  3. sudo nginx -t && sudo systemctl reload nginx
MSG
fi
