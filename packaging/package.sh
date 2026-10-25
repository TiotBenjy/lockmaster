#!/bin/sh
# `pnpm package` : paquets .deb et .rpm de l'application (packaging/nfpm.yaml) et du serveur de dépôt
# (packaging/nfpm-repo.yaml), ADR-0007 et ADR-0008. L'arborescence vient de packaging/stage.sh
# (commune avec l'image) ; nfpm est téléchargé à la version de packaging/versions.env et vérifié.
# Usage : sh packaging/package.sh [x64|arm64]   ->   out/*.deb out/*.rpm
set -eu
. "$(dirname "$0")/lib.sh"

arch=$(target_arch "${1:-}")
deb_arch=amd64
[ "$arch" = arm64 ] && deb_arch=arm64
version=$(node -p "require('$repo_root/package.json').version")

sh "$packaging_dir/stage.sh" "$arch"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
tar -xzf "$(nfpm_tarball)" -C "$work" nfpm
mkdir -p "$repo_root/out"
cd "$repo_root"
for packager in deb rpm; do
  LOCKMASTER_VERSION=$version LOCKMASTER_ARCH=$deb_arch \
    "$work/nfpm" package --config packaging/nfpm.yaml --packager "$packager" --target out/
  LOCKMASTER_VERSION=$version \
    "$work/nfpm" package --config packaging/nfpm-repo.yaml --packager "$packager" --target out/
done
