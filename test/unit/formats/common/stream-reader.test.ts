import { describe, expect, it } from 'vitest';
import { FormatError } from '../../../../src/formats/common/errors.js';
import { StreamReader } from '../../../../src/formats/common/stream-reader.js';

async function* pieces(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield Buffer.from(part, 'latin1');
}

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

describe('StreamReader', () => {
  it('lit des longueurs exactes à cheval sur plusieurs morceaux et compte la position', async () => {
    const reader = new StreamReader(pieces('ab', '', 'cdef', 'g'));
    expect(text(await reader.readExact(3))).toBe('abc');
    expect(await reader.readByte()).toBe(0x64);
    expect(reader.position).toBe(4);
    expect(await reader.peekByte()).toBe(0x65);
    expect(text(await reader.readExact(3))).toBe('efg');
    expect(await reader.peekByte()).toBeUndefined();
    expect(await reader.atEnd()).toBe(true);
    expect(text(await reader.readExact(0))).toBe('');
  });

  it('rend des copies indépendantes du morceau source', async () => {
    const reader = new StreamReader(pieces('abcd'));
    const first = await reader.readExact(2);
    first.fill(0x7a);
    expect(text(await reader.readExact(2))).toBe('cd');
  });

  it('lève FORMAT_CORRUPT_STREAM quand le flux se termine trop tôt', async () => {
    const reader = new StreamReader(pieces('abc'));
    await expect(reader.readExact(4)).rejects.toMatchObject({ code: 'FORMAT_CORRUPT_STREAM' });
    await expect(new StreamReader(pieces()).readByte()).rejects.toBeInstanceOf(FormatError);
  });

  it("remplit une fenêtre contiguë jusqu'à n octets ou la fin", async () => {
    const reader = new StreamReader(pieces('ab', 'cd', 'ef'));
    await reader.readExact(1);
    const window = await reader.fill(4);
    expect(text(window)).toBe('bcde');
    reader.skip(3);
    expect(text(await reader.fill(10))).toBe('ef');
    expect(reader.position).toBe(4);
  });

  it('refuse de sauter au-delà de la fenêtre chargée', async () => {
    const reader = new StreamReader(pieces('abc'));
    await reader.fill(2);
    expect(() => reader.skip(4)).toThrowError(expect.objectContaining({ code: 'FORMAT_CORRUPT_STREAM' }));
  });

  it("s'arrête sur un signal annulé (FORMAT_ABORTED)", async () => {
    const reader = new StreamReader(pieces('abc'), AbortSignal.abort());
    await expect(reader.readExact(1)).rejects.toMatchObject({ code: 'FORMAT_ABORTED' });
  });
});
