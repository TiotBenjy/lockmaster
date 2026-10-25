# Fonctions communes des tests de livrables (POSIX sh, sourcé). Ces tests vérifient les critères de
# sortie de M0 (docs/09) sur les vrais artefacts de out/ (pnpm package, pnpm image), dans des
# conteneurs : en CI comme en local, avec les mêmes scripts.

deliverables_dir=$(cd "$(dirname "$0")" && pwd)
repo_root=$(cd "$deliverables_dir/../.." && pwd)
out="$repo_root/out"
# shellcheck source=/dev/null
. "$repo_root/packaging/versions.env"

failures=0

fail() {
  echo "ÉCHEC : $*" >&2
  failures=$((failures + 1))
}

ok() {
  echo "ok : $*"
}

die() {
  echo "$(basename "$0") : $*" >&2
  exit 2
}

# check DESCRIPTION COMMANDE... : la commande doit réussir.
check() {
  label=$1
  shift
  if "$@" >/dev/null 2>&1; then ok "$label"; else fail "$label"; fi
}

# refuse DESCRIPTION COMMANDE... : la commande doit échouer.
refuse() {
  label=$1
  shift
  if "$@" >/dev/null 2>&1; then fail "$label"; else ok "$label"; fi
}

# Texte sans codes de couleur ANSI ni retours chariot : les sorties de `compose run` et `compose exec`
# en contiennent parfois (docker-compose derrière `podman compose`, sur un runner sans terminal).
plain() {
  printf '%s\n' "$1" | sed "s/$(printf '\033')\[[0-9;]*[A-Za-z]//g" | tr -d '\r'
}

# expect DESCRIPTION ATTENDU OBTENU
expect() {
  got=$(plain "$3")
  if [ "$2" = "$got" ]; then ok "$1"; else fail "$1 (attendu « $2 », obtenu « $got »)"; fi
}

# expect_match DESCRIPTION MOTIF TEXTE (motif grep -E)
expect_match() {
  if plain "$3" | grep -Eq -- "$2"; then ok "$1"; else fail "$1 (motif « $2 » absent de « $(plain "$3") »)"; fi
}

# Image épinglée par digest (packaging/versions.env) : DEBIAN_12, ROCKY_9...
pinned_image() {
  eval "ref=\${${1}_IMAGE:-}"
  [ -n "$ref" ] || die "image inconnue : $1"
  echo "$ref"
}

finish() {
  if [ "$failures" -gt 0 ]; then
    echo "$(basename "$0") : $failures échec(s)" >&2
    exit 1
  fi
  echo "$(basename "$0") : tous les contrôles passent"
}

# Ping du socket du signataire (protocole d'ADR-0009), exécuté par le Node embarqué. Affiche la
# réponse, ou « refusé <code> » si la connexion est refusée.
PING_JS='const s=require("net").connect(process.argv[1]);s.on("connect",()=>{const b=Buffer.from(JSON.stringify({op:"ping"}));const h=Buffer.alloc(4);h.writeUInt32BE(b.length);s.write(Buffer.concat([h,b]))});s.on("data",d=>{console.log(d.subarray(4).toString());s.end()});s.on("error",e=>console.log("refusé "+e.code))'
