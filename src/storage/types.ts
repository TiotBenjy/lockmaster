import type { PackageDigests } from '../domain/package.js';

// Interfaces du stockage des paquets (docs/01 §6, principe I) : lire un blob et en écrire un sont deux
// interfaces distinctes. Un blob est nommé par le sha256 de son contenu (CONVENTIONS.md, invariant 4) :
// aucun nom venant d'un utilisateur ou d'un paquet ne sert à construire un chemin.

/** Empreintes et taille calculées pendant l'écriture (colonnes de la table `artifact`). */
export interface BlobDigests extends PackageDigests {
  readonly size: number;
}

/** Résultat d'une écriture : `created` vaut faux si un blob de même contenu existait déjà. */
export interface StoredBlob extends BlobDigests {
  created: boolean;
}

export interface BlobWriteOptions {
  /** Taille maximale acceptée ; au-delà, l'écriture s'arrête et rien n'est conservé. */
  maxBytes: number;
  /** sha256 annoncé par l'appelant (en-tête d'upload, index amont signé) : vérifié avant stockage. */
  expectedSha256?: string;
  signal?: AbortSignal;
}

/** Écriture d'un blob : tout ou rien, jamais de remplacement d'un blob existant. */
export interface BlobWriter {
  write(source: AsyncIterable<Uint8Array>, options: BlobWriteOptions): Promise<StoredBlob>;
}

/**
 * Lecture des blobs par leur sha256 (64 caractères hexadécimaux en minuscules). Une implémentation
 * persistante revérifie le contenu pendant `read` et lève BLOB_CORRUPT en fin de flux s'il a changé :
 * un consommateur ne retient son résultat (verdict de scan, envoi vers une cible) qu'après un flux
 * terminé sans erreur.
 */
export interface BlobStore {
  has(sha256: string): Promise<boolean>;
  read(sha256: string, signal?: AbortSignal): AsyncIterable<Uint8Array>;
}
