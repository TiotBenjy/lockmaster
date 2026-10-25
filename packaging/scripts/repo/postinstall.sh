#!/bin/sh
# postinstall de lockmaster-repo (.deb « configure [ancienne version] », .rpm 1 ou 2), ADR-0008 et
# docs/08 §2.1. Idempotent : ne modifie jamais un répertoire ou un fichier existant, ne recharge pas
# nginx, ne génère aucun secret.
set -e

root=/srv/lockmaster-repo
home=/home/lockmaster-sync

# >>> fonctions (testées par test/integration/repo-postinstall.test.ts)
warn() {
  echo "lockmaster-repo : AVERTISSEMENT : $*" >&2
}

# Racine du dépôt et ses deux dossiers, créés SEULEMENT si la racine n'existe pas : une racine
# existante appartient au publieur (compte non privilégié), et root n'y touche à rien (un lien posé
# par ce compte serait suivi). Racine créée en root 0700, enfants d'abord, propriétaire en dernier.
# Répertoires 0750 setgid (fichiers publiés en 0640) : nginx lit par le groupe, n'écrit rien.
create_repo_tree() { # $1 racine, $2 propriétaire, $3 groupe
  mkdir -p "$(dirname "$1")"
  if ! mkdir -m 0700 "$1" 2>/dev/null; then
    for dir in "$1" "$1/public" "$1/private"; do
      if [ -L "$dir" ] || [ ! -d "$dir" ]; then warn "$dir absent ou lien symbolique : arborescence à vérifier"; fi
    done
    return 0
  fi
  install -d -m 2750 -o "$2" -g "$3" "$1/public" "$1/private"
  chown "$2:$3" "$1"
  chmod 2750 "$1"
}

# Chemins qui ne doivent être modifiables que par root (sinon lockmaster-sync pourrait s'ajouter une
# clé sans la restriction rrsync), par exemple un home préparé à la main avant le paquet.
check_root_owned() {
  for path in "$@"; do
    [ -e "$path" ] || [ -L "$path" ] || continue
    rights=$(stat -c '%A' "$path")
    if [ -L "$path" ] || [ "$(stat -c '%u' "$path")" != 0 ] ||
      [ "$(echo "$rights" | cut -c6)" = w ] || [ "$(echo "$rights" | cut -c9)" = w ]; then
      warn "$path doit appartenir à root et n'être modifiable que par lui"
    fi
  done
}

# Home du compte rsync, créé SEULEMENT s'il n'existe pas : .ssh et authorized_keys à root, lisibles
# par le seul groupe du compte (il ne peut pas s'ajouter de clé). Un home existant (préparé à la main,
# éventuellement au compte) n'est jamais modifié en root : ses droits sont seulement vérifiés.
create_sync_home() { # $1 home, $2 groupe du compte, $3 racine du dépôt, $4 chemin de rrsync
  mkdir -p "$(dirname "$1")"
  if ! mkdir -m 0700 "$1" 2>/dev/null; then
    check_root_owned "$1" "$1/.ssh" "$1/.ssh/authorized_keys"
    return 0
  fi
  install -d -m 0750 -g "$2" "$1/.ssh"
  {
    echo "# Clés de publication de lockmaster (cible rsync), une par ligne, toujours avec la restriction :"
    echo "# command=\"${4:-rrsync} $3\",restrict ssh-ed25519 AAAA... lockmaster@hote-application"
  } >"$1/.ssh/authorized_keys"
  chgrp "$2" "$1/.ssh/authorized_keys" "$1"
  chmod 0640 "$1/.ssh/authorized_keys"
  chmod 0750 "$1"
}
# <<< fonctions

case "${1-}" in
  configure) first=${2:-yes} ;;
  1) first=yes ;;
  2) first= ;;
  *) exit 0 ;;
esac
[ "$first" = yes ] || first=

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
create_repo_tree "$root" "$owner" lockmaster-repo

# Compte rsync : chaque clé doit être restreinte par rrsync à la racine du dépôt.
rrsync=
for candidate in /usr/bin/rrsync /usr/share/rsync/scripts/rrsync /usr/libexec/rsync/rrsync; do
  if [ -x "$candidate" ]; then
    rrsync=$candidate
    break
  fi
done
create_sync_home "$home" lockmaster-sync "$root" "$rrsync"
[ -n "$rrsync" ] || warn "rrsync introuvable : la cible rsync ne fonctionnera pas sans lui (voir docs/08 §2.2)"

# Barrière contre les liens symboliques (docs/02) : rien de lockmaster ne doit être lisible par nginx.
repo_gid=$(getent group lockmaster-repo | cut -d: -f3)
for path in /var/lib/lockmaster /etc/lockmaster /var/lib/lockmaster-signer /etc/lockmaster-signer "$home"; do
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
    # Première installation seulement : ensuite, l'arborescence appartient au publieur.
    [ -z "$first" ] || restorecon -R "$root" || warn "restorecon a échoué sur $root"
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
