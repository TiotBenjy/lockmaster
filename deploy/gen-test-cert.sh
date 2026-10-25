#!/bin/sh
# Certificat TLS AUTO-SIGNÉ pour le service `repo` (nginx) en test et en développement uniquement :
# jamais en production (aucun client ne doit faire confiance à ce certificat).
# Écrit <dossier>/repo.crt et <dossier>/repo.key (par défaut deploy/tls, monté par compose.yaml) ; ne
# remplace jamais un certificat existant. La clé est lisible par tous (0644) pour que nginx (UID 101)
# la lise à travers le montage, quel que soit le mapping d'UID du moteur : acceptable pour un
# certificat de test, jamais pour un vrai.
# Usage : sh deploy/gen-test-cert.sh [dossier] [nom d'hôte]
set -eu

dir=${1:-$(dirname "$0")/tls}
name=${2:-localhost}
case "$name" in
  *[!A-Za-z0-9.-]* | '') echo "gen-test-cert : nom d'hôte invalide : $name" >&2; exit 64 ;;
esac
if [ -e "$dir/repo.crt" ] || [ -e "$dir/repo.key" ]; then
  echo "gen-test-cert : $dir/repo.crt ou repo.key existe déjà, rien n'est remplacé" >&2
  exit 1
fi
mkdir -p "$dir"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 \
  -subj "/CN=$name" -addext "subjectAltName=DNS:$name,DNS:localhost,IP:127.0.0.1" \
  -keyout "$dir/repo.key" -out "$dir/repo.crt" 2>/dev/null
chmod 0644 "$dir/repo.key" "$dir/repo.crt"
echo "gen-test-cert : certificat de TEST écrit dans $dir (30 jours, $name)"
