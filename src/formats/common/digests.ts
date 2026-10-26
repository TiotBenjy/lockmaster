// Empreintes d'un paquet en une seule lecture : sha256 et sha512 (identité, vérification), md5 et sha1
// (compatibilité des métadonnées publiées). `node:crypto` n'est pas une API d'entrée-sortie.

import { createHash } from 'node:crypto';
import type { PackageDigests } from '../../domain/package.js';
import type { ByteSource } from './source.js';

export async function computeDigests(source: ByteSource, signal?: AbortSignal): Promise<PackageDigests> {
  const hashes = {
    md5: createHash('md5'),
    sha1: createHash('sha1'),
    sha256: createHash('sha256'),
    sha512: createHash('sha512'),
  };
  for await (const chunk of source.stream(0, source.size, signal)) {
    for (const hash of Object.values(hashes)) hash.update(chunk);
  }
  return {
    md5: hashes.md5.digest('hex'),
    sha1: hashes.sha1.digest('hex'),
    sha256: hashes.sha256.digest('hex'),
    sha512: hashes.sha512.digest('hex'),
  };
}
