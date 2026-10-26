// Décompression en flux et bornée de contenus non fiables (invariant 2, SEC-01, SEC-22, ADR-0015).
// Chaque algorithme est un décodeur enregistré dans `DECODERS` : en ajouter un ne change pas les
// appelants. Toute sortie passe par un `OutputMeter` ; une erreur du décodeur devient une
// `FormatError` au code stable, jamais un résultat partiel.

import { Readable, type Transform } from 'node:stream';
import { constants, createGunzip, createZstdDecompress } from 'node:zlib';
import { decodeBzip2 } from './bzip2/decoder.js';
import { FormatError, throwIfAborted } from './errors.js';
import { type FormatLimits, OutputMeter } from './limits.js';
import { decodeXz } from './xz/stream.js';

export type Compression = 'none' | 'gzip' | 'zstd' | 'xz' | 'bzip2';

export interface DecompressOptions {
  /** Sortie maximale, en général `decompressionBudget(...)`. */
  readonly maxOutputBytes: number;
  readonly limits: FormatLimits;
  readonly signal?: AbortSignal;
}

type Decoder = (input: AsyncIterable<Uint8Array>, options: DecompressOptions) => AsyncIterable<Uint8Array>;

const DECODERS: Readonly<Record<Compression, Decoder>> = Object.freeze({
  none: (input) => input,
  gzip: (input) => throughZlib(input, createGunzip(), 'gzip'),
  zstd: (input, options) =>
    throughZlib(
      input,
      createZstdDecompress({ params: { [constants.ZSTD_d_windowLogMax]: options.limits.zstdWindowLog } }),
      'zstd',
    ),
  xz: (input, options) =>
    decodeXz(input, {
      maxOutputBytes: options.maxOutputBytes,
      maxDictionaryBytes: options.limits.xzMaxDictionaryBytes,
      ...(options.signal ? { signal: options.signal } : {}),
    }),
  bzip2: (input, options) =>
    decodeBzip2(input, {
      maxOutputBytes: options.maxOutputBytes,
      ...(options.signal ? { signal: options.signal } : {}),
    }),
});

/** Nom d'algorithme venant d'un paquet -> `Compression`, ou `FORMAT_UNSUPPORTED_COMPRESSION`. */
export function asCompression(name: string): Compression {
  if (Object.hasOwn(DECODERS, name)) return name as Compression;
  throw new FormatError('FORMAT_UNSUPPORTED_COMPRESSION', 'algorithme de compression non pris en charge');
}

export async function* decompress(
  input: AsyncIterable<Uint8Array>,
  compression: Compression,
  options: DecompressOptions,
): AsyncGenerator<Uint8Array> {
  throwIfAborted(options.signal);
  const meter = new OutputMeter(options.maxOutputBytes);
  for await (const chunk of DECODERS[compression](input, options)) {
    throwIfAborted(options.signal);
    meter.add(chunk.length);
    yield chunk;
  }
}

/** Décompresse entièrement en mémoire : réservé aux petits membres (contrôle, au plus 10 MiB). */
export async function decompressToBuffer(
  input: AsyncIterable<Uint8Array>,
  compression: Compression,
  options: DecompressOptions,
): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const chunk of decompress(input, compression, options)) parts.push(chunk);
  return Buffer.concat(parts);
}

async function* throughZlib(
  input: AsyncIterable<Uint8Array>,
  engine: Transform,
  algorithm: string,
): AsyncGenerator<Uint8Array> {
  const source = Readable.from(input, { objectMode: false });
  // Une erreur de la source (lecture du blob) n'est pas une donnée corrompue : relancée telle quelle.
  let sourceFailed = false;
  source.on('error', (error) => {
    sourceFailed = true;
    engine.destroy(error);
  });
  source.pipe(engine);
  try {
    for await (const chunk of engine) yield chunk as Buffer;
  } catch (error) {
    throw sourceFailed ? error : asFormatError(error, algorithm);
  } finally {
    source.destroy();
    engine.destroy();
  }
}

/** Erreur du moteur zlib/zstd (la source a échoué ailleurs) : donnée corrompue ou fenêtre excessive. */
function asFormatError(error: unknown, algorithm: string): FormatError {
  const code = (error as { code?: unknown }).code;
  if (code === 'ZSTD_error_frameParameter_windowTooLarge') {
    return new FormatError('FORMAT_LIMIT_EXCEEDED', 'flux zstd : fenêtre au-delà de la limite');
  }
  return new FormatError('FORMAT_CORRUPT_STREAM', `flux ${algorithm} corrompu`, { cause: error });
}
