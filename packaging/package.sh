#!/bin/sh
# `pnpm package` : paquets .deb et .rpm de l'application (packaging/nfpm.yaml) et du serveur de dépôt
# (packaging/nfpm-repo.yaml), ADR-0007 et ADR-0008. Node.js, Grype et nfpm sont téléchargés aux
# versions de packaging/versions.env et vérifiés par SHA-256 ; better-sqlite3 est compilé depuis ses
# sources (packaging/build-native.sh) s'il ne l'est pas déjà.
# Usage : sh packaging/package.sh [x64|arm64]   ->   out/*.deb out/*.rpm
set -eu
. "$(dirname "$0")/lib.sh"

arch=$(target_arch "${1:-}")
deb_arch=amd64
[ "$arch" = arm64 ] && deb_arch=arm64
version=$(node -p "require('$repo_root/package.json').version")

native="$repo_root/out/native/linux-$arch/better_sqlite3.node"
[ -f "$native" ] || sh "$packaging_dir/build-native.sh" "$arch"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

# out/stage/root = /usr/lib/lockmaster ; out/stage/doc = /usr/share/doc/lockmaster.
stage="$repo_root/out/stage"
rm -rf "$stage"
node "$repo_root/scripts/build.mjs" --out "$stage/root" --native "$native"
mkdir -p "$stage/root/node/bin" "$stage/root/bin" "$stage/doc"

node_dir="node-v$NODE_VERSION-linux-$arch"
tar -xJf "$(node_tarball "$arch")" -C "$work" "$node_dir/bin/node" "$node_dir/LICENSE"
install -m 0755 "$work/$node_dir/bin/node" "$stage/root/node/bin/node"

mkdir "$work/grype"
tar -xzf "$(grype_tarball "$arch")" -C "$work/grype" grype LICENSE
install -m 0755 "$work/grype/grype" "$stage/root/bin/grype"
install -m 0755 "$packaging_dir/bin/lockmaster" "$stage/root/bin/lockmaster"

install -m 0644 "$repo_root/LICENSE" "$repo_root/README.md" "$stage/root/THIRD-PARTY-LICENSES.txt" "$stage/doc/"
install -m 0644 "$work/$node_dir/LICENSE" "$stage/doc/LICENSE.nodejs"
install -m 0644 "$work/grype/LICENSE" "$stage/doc/LICENSE.grype"
mkdir -p "$stage/doc/adr" "$stage/doc/examples"
install -m 0644 "$repo_root"/docs/adr/0009-*.md "$stage/doc/adr/"
install -m 0644 "$packaging_dir/examples/master-key-credential.conf" "$stage/doc/examples/"
rm "$stage/root/LICENSE" "$stage/root/THIRD-PARTY-LICENSES.txt"

mkdir "$work/nfpm"
tar -xzf "$(nfpm_tarball)" -C "$work/nfpm" nfpm
mkdir -p "$repo_root/out"
cd "$repo_root"
for packager in deb rpm; do
  LOCKMASTER_VERSION=$version LOCKMASTER_ARCH=$deb_arch \
    "$work/nfpm/nfpm" package --config packaging/nfpm.yaml --packager "$packager" --target out/
  LOCKMASTER_VERSION=$version \
    "$work/nfpm/nfpm" package --config packaging/nfpm-repo.yaml --packager "$packager" --target out/
done
