#!/bin/sh
# Autotest des fonctions de lib.sh (sans conteneur), lancé par test/unit/packaging/deliverables.test.ts.
# Les sorties de `compose run` et `compose exec` peuvent commencer par des codes de couleur ANSI
# (docker-compose derrière `podman compose`) : les comparaisons doivent les ignorer.
set -eu
. "$(dirname "$0")/lib.sh"

esc=$(printf '\033')
expect_match "motif ancré malgré un code de couleur" '^refusé E(ACCES|PERM)' "${esc}[0mrefusé EACCES"
expect "égalité malgré un code de couleur" lo "${esc}[0mlo${esc}[0m"

# Témoin : une vraie différence reste un échec.
before=$failures
expect_match "témoin" '^refusé' "accepté" 2>/dev/null
[ "$failures" -eq $((before + 1)) ] || fail "expect_match ne détecte plus une vraie différence"
failures=$before

finish
