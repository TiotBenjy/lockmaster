# ADR-0015 : Décompression xz et bzip2 et lecture tar sans dépendance

- Statut : accepté (décision du porteur, 2026-10-26)
- Date : 2026-10-26
- Modifie ADR-0001 (ligne « Archives » : `tar-stream` et décodeur xz « à sélectionner en M1 »)

## Contexte

M1 doit lire des contenus non fiables en flux et avec des bornes (invariant 2, `docs/02` §3.2) :
`control.tar` et `data.tar` des `.deb`, payload cpio des `.rpm`, membres des `.apk`. Le même code
fournit à clamd chaque flux interne décompressé (SEC-01), et SEC-22 demande de borner la mémoire des
décompresseurs (fenêtre zstd, limite xz). `node:zlib` couvre gzip et zstd ; il ne couvre ni xz ni
bzip2. Compressions à prendre en charge (deb(5), `rpm-payloadflags(7)`) :

- `.deb` : `control.tar` en none, gzip, xz, zstd ; `data.tar` en plus bzip2 et lzma (format
  historique `.lzma`) ;
- `.rpm` : payload en gzip, bzip2, xz, lzma, zstd (zstd par défaut depuis le format rpm 6) ;
- `.apk` v2 : gzip seulement.

ADR-0001 avait retenu `tar-stream` et laissé le décodeur xz à choisir en M1. Constats de la
recherche du 2026-10-26 :

- `tar-stream` 3.2.2 dépend désormais de `bare-fs` (et, par lui, de `bare-url`, `bare-path`,
  `bare-events`, `bare-stream`), en plus de `streamx`, `b4a`, `fast-fifo`, `text-decoder`,
  `events-universal` : une dizaine de paquets pour lire quelques centaines de kilo-octets de
  `control.tar`. Il met en mémoire tout en-tête pax quelle que soit sa taille déclarée.
- `xz-decompress` (MIT, xz-embedded compilé en WASM) : dictionnaire maximal figé à 64 MiB dans le C,
  filtres BCJ non compilés, binaire WASM livré en base64 sans construction reproductible vérifiée,
  un seul décodeur actif à la fois (mutex), dernière version en juillet 2025. `xzwasm` en est
  l'ancêtre, moins actif. Les liaisons natives (`lzma-native`...) exigent un script d'installation.
- bzip2 : `seek-bzip` et `unbzip2-stream` (MIT) sont inactifs depuis 2020 et ne bornent ni la mémoire
  ni la sortie.
- xz-embedded (projet Tukaani) est sous licence 0BSD, compatible avec la liste de CLAUDE.md
  §Licence. Il borne le dictionnaire (`dict_max`) et rejette tout filtre autre que LZMA2 et BCJ.

## Décision

Décision du porteur, 2026-10-26 : aucune dépendance d'exécution pour la décompression et la
lecture d'archives. Tout est dans `src/formats/common/`, en TypeScript pur.

1. **xz** : portage TypeScript du décodeur d'xz-embedded (conteneur `.xz`, LZMA2, contrôles
   CRC32 et CRC64 ; SHA-256 par `node:crypto` ; flux concaténés et remplissage de flux), avec la
   mention de copyright 0BSD des auteurs d'xz-embedded en tête des fichiers portés. Le dictionnaire
   alloué est le plus petit de : la taille déclarée par le flux, `xzMaxDictionaryBytes` de
   `limits.ts` (64 MiB par défaut, preset `-9` d'xz), et le budget de sortie du flux (un dictionnaire
   plus grand que la sortie autorisée ne sert à rien). Les filtres BCJ ne sont portés que si de vrais
   paquets Debian 12/13 ou Rocky 9/10 les utilisent (vérifié par les tests sur paquets réels) ;
   d'ici là, tout filtre autre que LZMA2 est refusé.
2. **bzip2** : décodeur TypeScript écrit d'après le format (blocs, MTF, Huffman, BWT inverse), en
   s'aidant de `seek-bzip` (MIT) comme référence ; tout passage adapté porte son attribution. Taille
   de bloc au plus 900 000 octets, comme le format l'impose, contrôle CRC par bloc et du flux.
3. **lzma historique** (`data.tar.lzma`, payload rpm `lzdio`) : non pris en charge en v1. Un paquet
   qui l'utilise est refusé avec `FORMAT_UNSUPPORTED_COMPRESSION`, donc part en `error` (fail-closed,
   SEC-01). Ce format est déprécié par dpkg et absent des distributions cibles.
4. **tar** : lecteur maison en lecture seule (ustar, extensions GNU `L`/`K` et pax `x`/`g`), qui
   borne chaque en-tête étendu, chaque entrée et le nombre d'entrées, vérifie la somme de contrôle de
   chaque en-tête et ne crée jamais de fichier. `tar-stream` est retiré de la liste des bibliothèques
   retenues. Les générateurs de fixtures de test écrivent leurs archives eux-mêmes.
5. gzip et zstd restent sur `node:zlib`, avec `ZSTD_d_windowLogMax` = 27 (fenêtre de 128 MiB au plus,
   SEC-22).

Toute décompression passe par un compteur de sortie (`limits.ts`) : plafond absolu par usage
(10 MiB pour un membre de contrôle) et ratio au plus 100:1 par rapport à la taille compressée, au-delà
d'un plancher fixe pour les très petits flux. Un dépassement, une donnée corrompue ou une compression
inconnue lève une `LockmasterError` au code stable, jamais un résultat partiel considéré comme propre.

## Justification

- Le code qui lit les paquets est la première surface d'attaque (`docs/02` A2). Un décodeur maison
  borne exactement la mémoire, s'arrête sur `AbortSignal`, se teste et se fuzze avec le reste des
  parseurs, et n'apporte aucune dépendance transitive (A13, SEC-24).
- Le WASM de `xz-decompress` aurait fixé la borne mémoire hors de notre contrôle, sans BCJ, avec un
  binaire dont on ne peut pas vérifier la provenance.
- Le lecteur tar utile ici est petit (lecture d'en-têtes de 512 octets, sans écriture) ; une
  dizaine de paquets pour cela n'est pas proportionné, et la borne sur les en-têtes pax est nécessaire.

## Alternatives écartées

- `xz-decompress`, `xzwasm` : voir Contexte.
- Liaisons natives à liblzma ou libbz2 : script d'installation interdit, code natif exposé aux
  données non fiables dans le processus.
- `seek-bzip`, `unbzip2-stream` en dépendance : inactifs, sans borne mémoire ; `unbzip2-stream`
  repose sur l'ancienne API `through`.
- `tar-stream` : arbre de dépendances et en-têtes pax non bornés (voir Contexte).
- Lancer `xz`, `bzip2` ou `tar` du système : interdit par l'invariant 2.

## Conséquences

- Code : `src/formats/common/` contient `xz/`, `bzip2/`, `tar.ts`, `decompress.ts` (interface
  commune à tous les algorithmes) et `limits.ts`. Le portage xz (environ 2 000 lignes de C) est
  découpé en fichiers de moins de 400 lignes.
- Performance : les décodeurs JavaScript sont plus lents que les outils natifs ; ils tournent dans le
  pool de workers (`docs/01` §4). Mesure du 2026-10-26 (Node 24, une archive tar de bibliothèques
  système, sortie identique à l'original) : xz 13,8 Mio/s contre 45 Mio/s pour `xz -d` ; bzip2
  7,8 Mio/s contre 18 Mio/s pour `bzip2 -d`. Un écart gênant se traitera par un nouvel ADR, pas par
  un retour discret à une dépendance.
- Tests : vecteurs produits par les vrais outils en développement (`xz`, `bzip2` : flux de test
  commités sous `test/fixtures/corpus/`, générés par un script), corpus malformé (flux tronqué, CRC
  faux, dictionnaire excessif, filtre inconnu, bloc bzip2 trop grand), propriétés fast-check (aucune
  exception non typée, sortie bornée), aller-retour sur des données aléatoires.
- Sécurité : le portage passe par le `security-reviewer` comme tout code de `formats/`.
- Documents mis à jour : CLAUDE.md (stack et bibliothèques retenues), feuille de route (M1),
  `docs/04` §2 (lzma historique refusé). ADR-0001 reste inchangé (ADR accepté) : sa ligne
  « Archives » est remplacée par le présent ADR.
