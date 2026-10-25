#!/bin/sh
# Critère de sortie M0 « lockmaster-repo » (docs/09) : le paquet du serveur de dépôt (out/) installé sur
# Debian 12, Debian 13, Rocky 9 ou Rocky 10 : nginx -t OK (avec un certificat de test), répertoires et
# groupes créés, contexte SELinux posé sur Rocky (politique SELinux installée comme sur un hôte).
# Usage : sh test/deliverables/repo-package.sh DEBIAN_12|DEBIAN_13|ROCKY_9|ROCKY_10   (podman requis)
set -eu
. "$(dirname "$0")/lib.sh"

distro=${1:-}
case "$distro" in
  DEBIAN_12 | DEBIAN_13) package=$(ls "$out"/lockmaster-repo_*_all.deb) nginx_user=www-data ;;
  ROCKY_9 | ROCKY_10) package=$(ls "$out"/lockmaster-repo-*.noarch.rpm) nginx_user=nginx ;;
  *) die "usage : repo-package.sh DEBIAN_12|DEBIAN_13|ROCKY_9|ROCKY_10" ;;
esac
image=$(pinned_image "$distro")
name="lockmaster-test-repo-$(echo "$distro" | tr 'A-Z_' 'a-z-')"
file=$(basename "$package")

podman rm -f "$name" >/dev/null 2>&1 || true
trap 'podman rm -f "$name" >/dev/null 2>&1 || true' EXIT INT TERM
podman run -d --name "$name" -v "$out:/pkgs:ro,Z" "$image" sleep infinity >/dev/null
x() { podman exec "$name" sh -c "$1"; }

if x 'command -v apt-get' >/dev/null; then
  x "export DEBIAN_FRONTEND=noninteractive; apt-get -qq update && apt-get -qq install -y openssl /pkgs/$file >/tmp/install.log 2>&1" ||
    { x 'tail -30 /tmp/install.log'; die "installation de $file en échec"; }
else
  # Politique SELinux présente, comme sur un hôte Rocky (absente des images de conteneur).
  x "dnf -y -q install selinux-policy-targeted openssl /pkgs/$file >/tmp/install.log 2>&1" ||
    { x 'tail -30 /tmp/install.log'; die "installation de $file en échec"; }
fi
ok "$distro : $file installé"

# Répertoires, comptes et groupes (docs/08 §2.1).
expect "/srv/lockmaster-repo" "drwxr-s--- lockmaster-sync:lockmaster-repo" "$(x 'stat -c "%A %U:%G" /srv/lockmaster-repo')"
for dir in public private; do
  expect "/srv/lockmaster-repo/$dir" "drwxr-s--- lockmaster-sync:lockmaster-repo" "$(x "stat -c '%A %U:%G' /srv/lockmaster-repo/$dir")"
done
expect_match "$nginx_user membre de lockmaster-repo" "lockmaster-repo" "$(x "id -nG $nginx_user")"
expect_match "lockmaster-sync membre de lockmaster-repo" "lockmaster-repo" "$(x 'id -nG lockmaster-sync')"
expect "authorized_keys à root, lisible par le seul groupe" "-rw-r----- root:lockmaster-sync" \
  "$(x 'stat -c "%A %U:%G" /home/lockmaster-sync/.ssh/authorized_keys')"
expect "configuration nginx livrée" "$(cat "$repo_root/deploy/nginx/lockmaster-repo.conf")" \
  "$(x 'cat /etc/nginx/conf.d/lockmaster-repo.conf')"

# nginx -t avec un certificat de test (le paquet n'en génère aucun).
x 'openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 -subj /CN=repo.test \
  -keyout /etc/nginx/tls/repo.key -out /etc/nginx/tls/repo.crt >/dev/null 2>&1'
check "nginx -t" x 'nginx -t'

case "$distro" in
  ROCKY_*)
    expect_match "contexte SELinux de /srv/lockmaster-repo enregistré" 'httpd_sys_content_t' \
      "$(x 'semanage fcontext -l 2>/dev/null | grep lockmaster-repo' || true)"
    ;;
esac

check "réinstallation idempotente" x "if command -v apt-get >/dev/null; then dpkg -i /pkgs/$file; else rpm -Uvh --replacepkgs /pkgs/$file; fi"

finish
