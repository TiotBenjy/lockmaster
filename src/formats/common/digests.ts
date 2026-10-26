// Empreintes d'un paquet en une seule lecture : sha256 et sha512 (identité, vérification), md5 et sha1
// (compatibilité des métadonnées publiées), et au besoin le sha256 de la fin du fichier à partir d'un
// décalage (payload RPM). `node:crypto` n'est pas une API d'entrée-sortie.

import { createHash } from 'node:crypto';
import type { PackageDigests } from '../../domain/package.js';
import type { ByteSource } from './source.js';

export interface DigestsWithTail {
  readonly digests: PackageDigests;
  /** sha256 des octets de `tailStart` à la fin. */
  readonly tailSha256: string;
}

export async function computeDigestsWithTail(
  source: ByteSource,
  tailStart: number,
  signal?: AbortSignal,
): Promise<DigestsWithTail> {
  const hashes = {
    md5: createHash('md5'),
    sha1: createHash('sha1'),
    sha256: createHash('sha256'),
    sha512: createHash('sha512'),
  };
  const tail = createHash('sha256');
  let position = 0;
  for await (const chunk of source.stream(0, source.size, signal)) {
    for (const hash of Object.values(hashes)) hash.update(chunk);
    const from = Math.max(0, tailStart - position);
    if (from < chunk.length) tail.update(chunk.subarray(from));
    position += chunk.length;
  }
  return {
    digests: {
      md5: hashes.md5.digest('hex'),
      sha1: hashes.sha1.digest('hex'),
      sha256: hashes.sha256.digest('hex'),
      sha512: hashes.sha512.digest('hex'),
    },
    tailSha256: tail.digest('hex'),
  };
}

export async function computeDigests(source: ByteSource, signal?: AbortSignal): Promise<PackageDigests> {
  return (await computeDigestsWithTail(source, source.size, signal)).digests;
}
