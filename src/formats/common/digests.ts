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

/** Empreintes calculées au fil des morceaux (flux d'upload écrit sur disque, par exemple). */
export class DigestAccumulator {
  readonly #md5 = createHash('md5');
  readonly #sha1 = createHash('sha1');
  readonly #sha256 = createHash('sha256');
  readonly #sha512 = createHash('sha512');
  #size = 0;

  get size(): number {
    return this.#size;
  }

  update(chunk: Uint8Array): void {
    this.#size += chunk.length;
    for (const hash of [this.#md5, this.#sha1, this.#sha256, this.#sha512]) hash.update(chunk);
  }

  /** Rend les empreintes ; l'accumulateur n'est plus utilisable ensuite. */
  finish(): PackageDigests {
    return {
      sha256: this.#sha256.digest('hex'),
      sha512: this.#sha512.digest('hex'),
      sha1: this.#sha1.digest('hex'),
      md5: this.#md5.digest('hex'),
    };
  }
}

export async function computeDigestsWithTail(
  source: ByteSource,
  tailStart: number,
  signal?: AbortSignal,
): Promise<DigestsWithTail> {
  const accumulator = new DigestAccumulator();
  const tail = createHash('sha256');
  let position = 0;
  for await (const chunk of source.stream(0, source.size, signal)) {
    accumulator.update(chunk);
    const from = Math.max(0, tailStart - position);
    if (from < chunk.length) tail.update(chunk.subarray(from));
    position += chunk.length;
  }
  return { digests: accumulator.finish(), tailSha256: tail.digest('hex') };
}

export async function computeDigests(source: ByteSource, signal?: AbortSignal): Promise<PackageDigests> {
  return (await computeDigestsWithTail(source, source.size, signal)).digests;
}
