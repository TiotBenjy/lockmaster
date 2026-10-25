#!/bin/sh
# Critère de sortie M0 « image » (docs/09), procédure de docs/08 §3.2 : avec Podman rootless ou Docker,
#  - keys gen-master par `run --rm`, compose run --rm signer signer init, compose run --rm lockmaster init ;
#  - serve sans init : 78 ; compose up -d : /healthz OK ;
#  - service repo en lecture seule, 404 sur / (configuration nginx chargée) ;
#  - séparation du signataire : aucune interface réseau hors lo, données et volume inaccessibles à
#    l'application, socket joignable par l'application (groupe 10100) et refusé à un autre compte.
# Usage : sh test/deliverables/image.sh podman|docker   (image : pnpm image, ou LOCKMASTER_IMAGE)
set -eu
. "$(dirname "$0")/lib.sh"

engine=${1:-}
case "$engine" in podman | docker) ;; *) die "usage : image.sh podman|docker" ;; esac
version=$(node -p "require('$repo_root/package.json').version")
export LOCKMASTER_IMAGE="${LOCKMASTER_IMAGE:-ghcr.io/tiotbenjy/lockmaster:$version}"
export REPO_HTTPS_PORT=18443 REPO_HTTP_PORT=18080
image=$LOCKMASTER_IMAGE
project="lockmaster-test-$engine"

# L'image est construite par podman (pnpm image) : Docker la reçoit par save/load.
if [ "$engine" = docker ] && ! docker image inspect "$image" >/dev/null 2>&1; then
  podman save "$image" | docker load -q >/dev/null
fi

work=$(mktemp -d "$out/deliverables-$engine.XXXXXX")
# Ménage par le moteur : les fichiers appartiennent aux UID des conteneurs.
cleanup() {
  compose down -v >/dev/null 2>&1 || true
  "$engine" run --rm --user 0 --network none -v "$work:/w:z" --entrypoint sh "$image" -c 'rm -rf /w/*' >/dev/null 2>&1 || true
  rmdir "$work" 2>/dev/null || true
}
compose() { "$engine" compose -f "$work/compose.yaml" -p "$project" "$@"; }
trap cleanup EXIT INT TERM

cp "$repo_root/deploy/compose.yaml" "$repo_root/deploy/gen-test-cert.sh" "$work/"
cp -r "$repo_root/deploy/nginx" "$work/"
cp "$repo_root/deploy/lockmaster.example.toml" "$work/lockmaster.toml"
chmod 0644 "$work/lockmaster.toml"
sh "$work/gen-test-cert.sh" "$work/tls" >/dev/null

# Secrets (docs/08 §3.2) : 0400, propriétaire = UID du conteneur qui les lit.
(
  umask 077
  mkdir "$work/secrets"
  "$engine" run --rm --network none "$image" keys gen-master >"$work/secrets/master.key"
  "$engine" run --rm --network none "$image" keys gen-master >"$work/secrets/signer-master.key"
  printf 'mot-de-passe-de-test-solide\n' >"$work/secrets/admin_password"
  chmod 0400 "$work/secrets/"*
)
owner() { # UID FICHIERS...
  uid=$1
  shift
  if [ "$engine" = podman ]; then
    podman unshare chown "$uid" "$@"
  else
    for file in "$@"; do
      docker run --rm --user 0 --network none -v "$file:/f:z" --entrypoint chown "$image" "$uid" /f
    done
  fi
}
owner 10001 "$work/secrets/master.key" "$work/secrets/admin_password"
owner 10002 "$work/secrets/signer-master.key"
ok "$engine : secrets créés (keys gen-master)"

# set +e : sous dash, set -e vaut aussi dans $(...) et l'échec attendu arrêterait le script.
output=$(
  set +e
  compose run --rm --no-deps lockmaster serve 2>&1
  echo "code=$?"
)
expect_match "serve sans init : code 78" 'code=78' "$output"
expect_match "serve sans init : « exécuter lockmaster init »" 'exécuter lockmaster init' "$output"

check "compose run --rm signer signer init" compose run --rm signer signer init
check "compose run --rm lockmaster init --non-interactive" compose run --rm \
  -v "$work/secrets/admin_password:/run/secrets/admin_password:ro,z" lockmaster \
  init --non-interactive --admin-password-file /run/secrets/admin_password
check "compose up -d" compose up -d

healthz=
for _ in $(seq 1 60); do
  healthz=$(curl -fsS 127.0.0.1:8080/healthz 2>/dev/null || true)
  [ "$healthz" = ok ] && break
  sleep 1
done
expect "/healthz" ok "$healthz"
expect "repo : 404 sur /" 404 "$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$REPO_HTTPS_PORT/" || true)"
refuse "repo : système de fichiers en lecture seule" compose exec -T repo sh -c 'touch /etc/nginx/x'
refuse "repo : fichiers publiés en lecture seule" compose exec -T repo sh -c 'touch /srv/lockmaster-repo/x'

# tr : docker-compose peut ajouter des codes de couleur à la sortie.
interfaces=$(compose exec -T signer /app/node/bin/node -e 'console.log("if=" + require("fs").readdirSync("/sys/class/net").join(","))' 2>&1 |
  sed -n 's/.*if=//p' | tr -cd 'a-z0-9,')
expect "signer : aucune interface réseau hors lo" lo "$interfaces"
check "témoin : données du signataire présentes (vues par le signataire)" compose exec -T signer sh -c 'test -f /var/lib/lockmaster-signer/signer.db'
refuse "application : données du signataire illisibles" compose exec -T lockmaster sh -c 'ls /var/lib/lockmaster-signer'
expect "application : volume du signataire non monté" 0 \
  "$(compose exec -T lockmaster sh -c 'grep -c " /var/lib/lockmaster-signer " /proc/self/mountinfo' 2>/dev/null | tr -d '\r' || true)"
expect_match "socket : joignable par l'application" '"pong":true' \
  "$(compose exec -T lockmaster /app/node/bin/node -e "$PING_JS" /run/lockmaster-sign/sign.sock 2>&1)"
expect_match "socket : refusé à un autre compte (10003, sans groupe 10100)" '^refusé E(ACCES|PERM)' \
  "$(compose run --rm -T --no-deps --user 10003:10003 --entrypoint /app/node/bin/node signer -e "$PING_JS" /run/lockmaster-sign/sign.sock 2>&1 | tail -1)"

finish
