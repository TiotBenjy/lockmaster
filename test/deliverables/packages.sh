#!/bin/sh
# Critère de sortie M0 « paquets » (docs/09) : le .deb (Debian 12, 13) ou le .rpm (Rocky 9, 10) de out/
# est installé dans un conteneur dont systemd est le processus 1, puis :
#  - lockmaster serve sans init sort avec 78 et « exécuter lockmaster init » ;
#  - lockmaster init --non-interactive --admin-password-file, systemctl start lockmaster, /healthz ;
#  - séparation du signataire : fichiers illisibles pour lockmaster, socket refusé à un autre compte ;
#  - systemd-analyze verify, et security (signataire <= 1,0, application <= 2,0).
# Usage : sh test/deliverables/packages.sh DEBIAN_12|DEBIAN_13|ROCKY_9|ROCKY_10   (podman requis)
set -eu
. "$(dirname "$0")/lib.sh"

distro=${1:-}
case "$distro" in
  DEBIAN_12 | DEBIAN_13) package=$(ls "$out"/lockmaster_*_amd64.deb) ;;
  ROCKY_9 | ROCKY_10) package=$(ls "$out"/lockmaster-[0-9]*.x86_64.rpm) ;;
  *) die "usage : packages.sh DEBIAN_12|DEBIAN_13|ROCKY_9|ROCKY_10" ;;
esac
image=$(pinned_image "$distro")
name="lockmaster-test-packages-$(echo "$distro" | tr 'A-Z_' 'a-z-')"
file=$(basename "$package")

podman rm -f "$name" >/dev/null 2>&1 || true
trap 'podman rm -f "$name" >/dev/null 2>&1 || true' EXIT INT TERM

# systemd et curl d'abord, puis systemd devient le processus 1 ; le paquet s'installe ensuite, sous
# systemd, comme sur un hôte.
podman run -d --name "$name" --systemd=always -v "$out:/pkgs:ro,Z" "$image" sh -c '
  if command -v apt-get >/dev/null; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get -qq update && apt-get -qq install -y --no-install-recommends systemd systemd-sysv curl >/dev/null
  else
    dnf -y -q install systemd procps-ng >/dev/null
  fi
  exec /usr/lib/systemd/systemd' >/dev/null

x() { podman exec "$name" sh -c "$1"; }

state=
for _ in $(seq 1 180); do
  state=$(x 'systemctl is-system-running 2>/dev/null' || true)
  case "$state" in running | degraded) break ;; esac
  sleep 2
done
expect "$distro : systemd démarré" yes "$(case "$state" in running | degraded) echo yes ;; *) echo "$state" ;; esac)"

if x 'command -v apt-get' >/dev/null; then
  x "DEBIAN_FRONTEND=noninteractive apt-get -qq install -y --no-install-recommends /pkgs/$file >/tmp/install.log 2>&1" ||
    { x 'tail -30 /tmp/install.log'; die "installation de $file en échec"; }
else
  x "dnf -y -q install /pkgs/$file >/tmp/install.log 2>&1" ||
    { x 'tail -30 /tmp/install.log'; die "installation de $file en échec"; }
fi
ok "$distro : $file installé"

# serve sans init : 78 et message explicite.
output=$(x 'runuser -u lockmaster -- lockmaster serve --config /etc/lockmaster/lockmaster.toml 2>&1; echo "code=$?"' || true)
expect_match "serve sans init : code 78" 'code=78' "$output"
expect_match "serve sans init : « exécuter lockmaster init »" 'exécuter lockmaster init' "$output"

x 'umask 077 && printf "mot-de-passe-de-test-solide\n" >/root/admin_password'
check "lockmaster init --non-interactive" x 'lockmaster init --non-interactive --admin-password-file /root/admin_password'
check "systemctl start lockmaster" x 'systemctl start lockmaster'
healthz=
for _ in $(seq 1 30); do
  healthz=$(x 'curl -fsS localhost:8080/healthz' 2>/dev/null || true)
  [ "$healthz" = ok ] && break
  sleep 1
done
expect "/healthz" ok "$healthz"

# Séparation du signataire (ADR-0009).
refuse "lockmaster ne liste pas /var/lib/lockmaster-signer" x 'runuser -u lockmaster -- ls /var/lib/lockmaster-signer'
refuse "lockmaster ne lit pas la configuration du signataire" x 'runuser -u lockmaster -- cat /etc/lockmaster-signer/signer.toml'
refuse "lockmaster ne lit pas la clé maîtresse hors de son unité" x 'runuser -u lockmaster -- cat /etc/lockmaster/master.key'
ping=$(x "runuser -u nobody -- /usr/lib/lockmaster/node/bin/node -e '$PING_JS' /run/lockmaster-sign/sign.sock" 2>&1 || true)
expect_match "socket du signataire refusé à un autre compte" '^refusé E(ACCES|PERM)' "$ping"

# Unités : validité et exposition (systemd-analyze security, échelle 0-100 de --threshold).
check "systemd-analyze verify" x 'systemd-analyze verify /usr/lib/systemd/system/lockmaster.service /usr/lib/systemd/system/lockmaster-signer.socket /usr/lib/systemd/system/lockmaster-signer.service'
check "exposition du signataire <= 1,0" x 'systemd-analyze security --threshold=10 lockmaster-signer.service'
check "exposition de l'application <= 2,0" x 'systemd-analyze security --threshold=20 lockmaster.service'
# Témoin : le seuil s'exprime bien sur 100 (sinon les deux contrôles précédents passeraient à vide).
refuse "témoin : application refusée sous un seuil de 0,5" x 'systemd-analyze security --threshold=5 lockmaster.service'
x 'systemd-analyze security lockmaster-signer.service lockmaster.service 2>/dev/null | tail -3' || true

finish
