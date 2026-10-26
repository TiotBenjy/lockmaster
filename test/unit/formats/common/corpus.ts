// Lecture du corpus de compression commité (test/fixtures/corpus-generate.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAYLOADS } from '../../../fixtures/builders/payloads.js';
import type { CorpusEntry } from '../../../fixtures/corpus-generate.js';

const ROOT = join(import.meta.dirname, '../../../fixtures/corpus/compression');

export function corpusEntries(compression: CorpusEntry['compression']): CorpusEntry[] {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')) as CorpusEntry[];
  return manifest.filter((entry) => entry.compression === compression);
}

export function corpusFile(file: string): Buffer {
  return readFileSync(join(ROOT, file));
}

export function expectedOutput(entry: CorpusEntry): Buffer {
  return Buffer.concat(entry.payloads.map((name) => PAYLOADS[name]()));
}

export async function* chunked(bytes: Uint8Array, size = 4096): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}
