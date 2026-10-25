#!/bin/sh
# Arborescence commune aux trois livrables (ADR-0013), utilisée par package.sh (paquets) et image.sh
# (image OCI) :
#   out/stage/root = /usr/lib/lockmaster (paquets) = /app (image) : bundles, Node.js et Grype vérifiés
#                    par SHA-256 (packaging/versions.env), better-sqlite3 compilé depuis ses sources
#                    (packaging/build-native.sh), lanceur ;
#   out/stage/doc  = /usr/share/doc/lockmaster : licences (dont Node.js et Grype), documentation.
# Usage : sh packaging/stage.sh [x64|arm64]
set -eu
. "$(dirname "$0")/lib.sh"

arch=$(target_arch "${1:-}")
native="$repo_root/out/native/linux-$arch/better_sqlite3.node"
[ -f "$native" ] || sh "$packaging_dir/build-native.sh" "$arch"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

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
echo "stage : $stage ($arch)"
