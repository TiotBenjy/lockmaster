#!/bin/sh
# Compile le module natif de better-sqlite3 DEPUIS SES SOURCES (SEC-24), dans AlmaLinux 9 (glibc 2.34,
# la plus ancienne des distributions visées) avec le Node.js embarqué, vérifié par SHA-256 : ses
# en-têtes et son node-gyp servent à la compilation. Le binaire convient aux trois livrables.
# Usage : sh packaging/build-native.sh [x64|arm64]   ->   out/native/linux-<arch>/better_sqlite3.node
set -eu
. "$(dirname "$0")/lib.sh"

arch=$(target_arch "${1:-}")
platform=linux/amd64
[ "$arch" = arm64 ] && platform=linux/arm64
engine=$(container_engine)
node_archive=$(node_tarball "$arch")

src=$(readlink -f "$repo_root/node_modules/better-sqlite3")
addon=$(readlink -f "$src/../node-addon-api")
[ -f "$src/binding.gyp" ] && [ -d "$addon" ] || die "sources de better-sqlite3 introuvables : pnpm install d'abord"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
mkdir -p "$work/better-sqlite3/node_modules"
cp -RL "$src/." "$work/better-sqlite3/"
cp -RL "$addon" "$work/better-sqlite3/node_modules/node-addon-api"
# Aucun binaire précompilé : seule la compilation des sources est acceptée.
rm -rf "$work/better-sqlite3/prebuilds" "$work/better-sqlite3/build"
cp "$node_archive" "$work/node.tar.xz"
chmod -R a+rX "$work"

# Les paquets de compilation viennent des dépôts AlmaLinux (signés) ; l'image est épinglée par digest.
"$engine" run --rm --platform "$platform" -v "$work:/w:Z" -w /w "$ALMALINUX_9_IMAGE" sh -euc '
  dnf -y -q install python3 make gcc-c++ xz tar >/dev/null
  mkdir -p /opt/node
  tar -xJf /w/node.tar.xz -C /opt/node --strip-components=1
  export PATH=/opt/node/bin:$PATH
  cd /w/better-sqlite3
  /opt/node/bin/node /opt/node/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js \
    rebuild --release --nodedir=/opt/node -- -Dforce_build=1 >/w/build.log 2>&1 || { tail -50 /w/build.log; exit 1; }
  # Le module doit se charger avec le Node embarqué, dans cette glibc.
  cd /w/better-sqlite3 && /opt/node/bin/node -e "const D=require(\"./lib\");new D(\":memory:\").prepare(\"select 1\").get()"
'

dest="$repo_root/out/native/linux-$arch"
mkdir -p "$dest"
cp "$work/better-sqlite3/build/Release/better_sqlite3.node" "$dest/better_sqlite3.node"
echo "build-native : $dest/better_sqlite3.node"
