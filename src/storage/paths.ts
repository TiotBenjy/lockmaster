import { LockmasterError } from '../domain/errors.js';

// Chemins calculés à partir de données de paquets (CONVENTIONS.md, invariant 4 ; piège S9) : un blob est
// nommé par son sha256, un chemin publié est construit puis validé ici, et nulle part ailleurs. Tout
// segment refusé lève une erreur : aucun nettoyage silencieux qui changerait le nom.

const SHA256 = /^[0-9a-f]{64}$/;
// Segment : ASCII sans espace ni « : », premier caractère alphanumérique ou « _ » (donc ni « . », ni
// « .. », ni fichier caché). Couvre les noms et versions deb/rpm/apk (« + », « ~ », « ^ »).
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._+~^-]*$/;
const MAX_SEGMENT_BYTES = 255;
const MAX_PATH_BYTES = 1024;
const MAX_SEGMENTS = 16;

const invalidPath = (reason: string) =>
  new LockmasterError('PUBLISHED_PATH_INVALID', `chemin publié refusé : ${reason}`);

/** Rend `value` s'il s'agit d'un sha256 en hexadécimal minuscule, sinon lève BLOB_INVALID_ID. */
export function assertSha256(value: string): string {
  if (!SHA256.test(value)) throw new LockmasterError('BLOB_INVALID_ID', 'identifiant de blob invalide');
  return value;
}

/** Chemin d'un blob relatif au dossier des blobs : `sha256/ab/cd/<sha256>` (docs/08 §4 bis). */
export function blobRelativePath(sha256: string): string {
  assertSha256(sha256);
  return `sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

function assertSegment(segment: string): void {
  if (segment.length > MAX_SEGMENT_BYTES) throw invalidPath('segment trop long');
  if (!SEGMENT.test(segment)) throw invalidPath(`segment non conforme (${JSON.stringify(segment.slice(0, 64))})`);
}

/** Valide un chemin publié relatif (sous public/ d'une cible) ; le rend inchangé s'il est conforme. */
export function assertPublishedPath(path: string): string {
  if (path.length > MAX_PATH_BYTES) throw invalidPath('chemin trop long');
  const segments = path.split('/');
  if (segments.length > MAX_SEGMENTS) throw invalidPath('trop de segments');
  for (const segment of segments) assertSegment(segment);
  return path;
}

export interface DebPoolEntry {
  component: string;
  source: string;
  name: string;
  version: string;
  arch: string;
}

/** Préfixe du pool Debian : `libX` pour une source lib* (au moins 4 caractères), première lettre sinon. */
function poolPrefix(source: string): string {
  return source.startsWith('lib') && source.length > 3 ? source.slice(0, 4) : source.slice(0, 1);
}

// « _ » sépare nom, version et architecture dans le nom de fichier : il y est refusé, sinon deux paquets
// distincts (a + b_c, a_b + c) auraient le même chemin. Les regex Debian l'excluent déjà de ces champs.
const DEB_FILE_FIELD = /^[A-Za-z0-9][A-Za-z0-9.+~-]*$/;

/** `pool/<composant>/<préfixe>/<source>/<nom>_<version sans epoch>_<arch>.deb` (docs/03 §2.2). */
export function debPoolPath(entry: DebPoolEntry): string {
  const version = entry.version.replace(/^[0-9]+:/, '');
  for (const segment of [entry.component, entry.source, entry.name, version, entry.arch]) assertSegment(segment);
  for (const field of [entry.name, version, entry.arch]) {
    if (!DEB_FILE_FIELD.test(field))
      throw invalidPath(`champ du nom de fichier non conforme (${JSON.stringify(field)})`);
  }
  const file = `${entry.name}_${version}_${entry.arch}.deb`;
  return assertPublishedPath(`pool/${entry.component}/${poolPrefix(entry.source)}/${entry.source}/${file}`);
}
