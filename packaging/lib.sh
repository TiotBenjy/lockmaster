# Fonctions communes des scripts de livraison (POSIX sh, sourcé). Versions et sommes : versions.env.
# Tout binaire externe est téléchargé en https puis vérifié par SHA-256 avant usage ; un fichier en
# cache est revérifié à chaque fois (jamais de confiance accordée au cache).

packaging_dir=$(cd "$(dirname "$0")" && pwd)
repo_root=$(dirname "$packaging_dir")
cache_dir="$repo_root/out/cache"
# shellcheck source=/dev/null
. "$packaging_dir/versions.env"

die() {
  echo "$(basename "$0") : $*" >&2
  exit 1
}

container_engine() {
  if command -v podman >/dev/null 2>&1; then echo podman; elif command -v docker >/dev/null 2>&1; then echo docker; else die "podman ou docker requis"; fi
}

# Architecture cible : x64 ou arm64 (noms de Node.js).
target_arch() {
  case "${1:-$(uname -m)}" in
    x86_64 | amd64 | x64) echo x64 ;;
    aarch64 | arm64) echo arm64 ;;
    *) die "architecture non prise en charge : ${1:-$(uname -m)}" ;;
  esac
}

# fetch_verified URL SHA256 FICHIER : télécharge si absent, vérifie toujours.
fetch_verified() {
  mkdir -p "$(dirname "$3")"
  if [ ! -f "$3" ]; then
    curl --proto '=https' --tlsv1.2 -sSfL --max-time 600 -o "$3.part" "$1"
    mv "$3.part" "$3"
  fi
  echo "$2  $3" | sha256sum -c --quiet - || {
    rm -f "$3"
    die "somme SHA-256 incorrecte pour $1"
  }
}

node_tarball() { # $1 = x64 | arm64
  eval "sum=\$NODE_SHA256_$(echo "$1" | tr a-z A-Z)"
  file="$cache_dir/node-v$NODE_VERSION-linux-$1.tar.xz"
  fetch_verified "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$1.tar.xz" "$sum" "$file"
  echo "$file"
}

grype_tarball() { # $1 = x64 | arm64
  garch=amd64
  [ "$1" = arm64 ] && garch=arm64
  eval "sum=\$GRYPE_SHA256_$(echo "$garch" | tr a-z A-Z)"
  file="$cache_dir/grype_${GRYPE_VERSION}_linux_$garch.tar.gz"
  fetch_verified "https://github.com/anchore/grype/releases/download/v$GRYPE_VERSION/grype_${GRYPE_VERSION}_linux_$garch.tar.gz" "$sum" "$file"
  echo "$file"
}

nfpm_tarball() { # architecture de la machine de build
  narch=x86_64
  [ "$(target_arch)" = arm64 ] && narch=arm64
  eval "sum=\$NFPM_SHA256_$(echo "$narch" | tr a-z A-Z)"
  file="$cache_dir/nfpm_${NFPM_VERSION}_Linux_$narch.tar.gz"
  fetch_verified "https://github.com/goreleaser/nfpm/releases/download/v$NFPM_VERSION/nfpm_${NFPM_VERSION}_Linux_$narch.tar.gz" "$sum" "$file"
  echo "$file"
}
