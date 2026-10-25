#!/bin/sh
# Régénère packaging/versions.env : versions épinglées des outils et binaires externes, avec leurs
# SHA-256 tirés UNIQUEMENT de fichiers de sommes SIGNÉS et vérifiés (CLAUDE.md : jamais un hash
# recopié d'une page web), et les digests des images de base.
#   - Node.js : SHASUMS256.txt.asc vérifié par gpgv avec packaging/keys/nodejs-release-keys.kbx ;
#   - Grype, nfpm : fichier de sommes signé sigstore, vérifié par cosign (identité exacte du workflow
#     de publication de LEUR dépôt) ; cosign tourne depuis son image épinglée par digest ;
#   - images : digest relevé au téléchargement (podman, sinon docker).
# Outil de mainteneur (réseau requis) : le diff de versions.env est relu par un humain (CODEOWNERS).
# Usage : sh packaging/update-pins.sh   (versions choisies ci-dessous)
set -eu

NODE_VERSION=24.22.1
GRYPE_VERSION=0.120.1
NFPM_VERSION=2.48.0
COSIGN_IMAGE=ghcr.io/sigstore/cosign/cosign:v3.1.3
IMAGES="ALMALINUX_9=docker.io/library/almalinux:9
DEBIAN_SLIM=docker.io/library/debian:13-slim
NGINX_UNPRIVILEGED=docker.io/nginxinc/nginx-unprivileged:1.28-alpine
CLAMAV=docker.io/clamav/clamav:1.4
NODE_BUILDER=docker.io/library/node:24-bookworm"

here=$(cd "$(dirname "$0")" && pwd)
out="$here/versions.env"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

engine=podman
command -v podman >/dev/null 2>&1 || { echo "update-pins: podman requis" >&2; exit 1; }

fetch() { curl --proto '=https' --tlsv1.2 -sSfL --max-time 120 -o "$2" "$1"; }

# Digest de l'INDEX multi-architecture (et non du manifeste d'une seule architecture) : parmi les
# RepoDigests de l'image, celui que `podman manifest inspect` lit comme une liste.
digest_of() {
  "$engine" pull -q "$1" >/dev/null
  for ref in $("$engine" image inspect --format '{{range .RepoDigests}}{{.}} {{end}}' "$1"); do
    if "$engine" manifest inspect "$ref" >/dev/null 2>&1; then
      echo "${ref##*@}"
      return 0
    fi
  done
  echo "update-pins: pas d'index multi-architecture pour $1" >&2
  return 1
}

# Node.js : sommes signées par un releaser actif.
fetch "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt.asc" "$work/node.asc"
gpgv --keyring "$here/keys/nodejs-release-keys.kbx" --output "$work/node.sums" "$work/node.asc" 2>"$work/gpgv.log" || {
  cat "$work/gpgv.log" >&2
  echo "update-pins: signature de SHASUMS256.txt invalide" >&2
  exit 1
}
node_sum() { awk -v f="node-v$NODE_VERSION-linux-$1.tar.xz" '$2 == f { print $1 }' "$work/node.sums"; }

# cosign : ancre de confiance des vérifications suivantes. Son digest est repris de versions.env
# (déjà relu) ; en changer est une décision explicite : COSIGN_REPIN=1 relève le digest du tag.
cosign_ref=$(sed -n 's/^COSIGN_IMAGE=//p' "$out" 2>/dev/null || true)
if [ -z "$cosign_ref" ] || [ "${COSIGN_REPIN-}" = 1 ]; then
  cosign_ref="${COSIGN_IMAGE%%:*}@$(digest_of "$COSIGN_IMAGE")"
  echo "update-pins: image cosign épinglée à $cosign_ref (nouveau digest : à relire)" >&2
fi
verify_sigstore() { # $1 fichier de sommes, $2 bundle, $3 identité exacte du workflow de publication
  # Fichiers publics : lisibles par l'utilisateur non-root de l'image cosign.
  chmod a+rx "$work" && chmod a+r "$work/$1" "$work/$2"
  "$engine" run --rm --network host -v "$work:/w:ro,Z" "$cosign_ref" verify-blob \
    --bundle "/w/$2" \
    --certificate-identity "$3" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    "/w/$1" >/dev/null
}

grype_base="https://github.com/anchore/grype/releases/download/v$GRYPE_VERSION"
fetch "$grype_base/grype_${GRYPE_VERSION}_checksums.txt" "$work/grype.sums"
fetch "$grype_base/grype_${GRYPE_VERSION}_checksums.txt.sigstore.json" "$work/grype.bundle"
# Grype publie depuis main (déclenchement manuel du workflow), pas depuis le tag.
verify_sigstore grype.sums grype.bundle \
  "https://github.com/anchore/grype/.github/workflows/release.yaml@refs/heads/main"
grype_sum() { awk -v f="grype_${GRYPE_VERSION}_linux_$1.tar.gz" '$2 == f { print $1 }' "$work/grype.sums"; }

nfpm_base="https://github.com/goreleaser/nfpm/releases/download/v$NFPM_VERSION"
fetch "$nfpm_base/checksums.txt" "$work/nfpm.sums"
fetch "$nfpm_base/checksums.txt.sigstore.json" "$work/nfpm.bundle"
verify_sigstore nfpm.sums nfpm.bundle \
  "https://github.com/goreleaser/nfpm/.github/workflows/release.yml@refs/tags/v$NFPM_VERSION"
nfpm_sum() { awk -v f="nfpm_${NFPM_VERSION}_Linux_$1.tar.gz" '$2 == f { print $1 }' "$work/nfpm.sums"; }

require() { [ -n "$2" ] || { echo "update-pins: somme absente pour $1" >&2; exit 1; }; }

{
  echo "# FICHIER GÉNÉRÉ par packaging/update-pins.sh le $(date -u +%Y-%m-%d) : ne pas éditer à la main."
  echo "# Sommes tirées de fichiers signés et vérifiés (gpgv, cosign) ; digests relevés au téléchargement."
  echo "NODE_VERSION=$NODE_VERSION"
  for arch in x64 arm64; do v=$(node_sum "$arch"); require "node $arch" "$v"; echo "NODE_SHA256_$(echo "$arch" | tr a-z A-Z)=$v"; done
  echo "GRYPE_VERSION=$GRYPE_VERSION"
  for arch in amd64 arm64; do v=$(grype_sum "$arch"); require "grype $arch" "$v"; echo "GRYPE_SHA256_$(echo "$arch" | tr a-z A-Z)=$v"; done
  echo "NFPM_VERSION=$NFPM_VERSION"
  for arch in x86_64 arm64; do v=$(nfpm_sum "$arch"); require "nfpm $arch" "$v"; echo "NFPM_SHA256_$(echo "$arch" | tr a-z A-Z)=$v"; done
  echo "COSIGN_IMAGE=$cosign_ref"
  echo "$IMAGES" | while IFS='=' read -r name ref; do
    echo "${name}_IMAGE=${ref%%:*}@$(digest_of "$ref")"
    echo "${name}_TAG=${ref##*:}"
  done
} >"$work/versions.env"

mv "$work/versions.env" "$out"
echo "update-pins: $out mis à jour ; relire le diff avant de committer."
