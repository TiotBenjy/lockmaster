#!/bin/sh
# `pnpm image` : image OCI de lockmaster (packaging/Containerfile) avec podman, ou docker si podman est
# absent. Le contexte de construction est l'arborescence commune des livrables (packaging/stage.sh).
# Usage : sh packaging/image.sh [x64|arm64]   ->   ghcr.io/tiotbenjy/lockmaster:<version>
#         (LOCKMASTER_IMAGE=<nom:tag> pour un autre nom, essais locaux)
set -eu
. "$(dirname "$0")/lib.sh"

arch=$(target_arch "${1:-}")
platform=linux/amd64
[ "$arch" = arm64 ] && platform=linux/arm64
version=$(node -p "require('$repo_root/package.json').version")
image=${LOCKMASTER_IMAGE:-ghcr.io/tiotbenjy/lockmaster:$version}
engine=$(container_engine)

sh "$packaging_dir/stage.sh" "$arch"

# Format docker sous podman : le format OCI ignore HEALTHCHECK.
format=
[ "$engine" = podman ] && format='--format docker'
# shellcheck disable=SC2086
"$engine" build $format --platform "$platform" \
  --build-arg "BASE_IMAGE=$DEBIAN_SLIM_IMAGE" --build-arg "VERSION=$version" \
  --file "$packaging_dir/Containerfile" --tag "$image" "$repo_root/out/stage"
echo "image : $image"
