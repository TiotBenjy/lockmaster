import { describe, expect, it } from 'vitest';
import { LockmasterError } from '../../../src/domain/errors.js';
import {
  encodeFrame,
  FrameReader,
  MAX_FRAME_BYTES,
  parseRequest,
  parseResponse,
} from '../../../src/domain/signer-protocol.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof LockmasterError ? error.code : String(error);
  }
  return undefined;
}

describe('trames du protocole du signataire (ADR-0009)', () => {
  it('encode une longueur sur 4 octets big-endian suivie du JSON', () => {
    const frame = encodeFrame({ op: 'ping' });
    expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
    expect(JSON.parse(frame.subarray(4).toString('utf8'))).toEqual({ op: 'ping' });
  });

  it('relit une trame reçue en plusieurs morceaux, et une seule', () => {
    const reader = new FrameReader();
    const frame = encodeFrame({ op: 'ping' });
    expect(reader.push(frame.subarray(0, 3))).toBeUndefined();
    expect(reader.push(frame.subarray(3))).toEqual({ op: 'ping' });
  });

  it("refuse une longueur annoncée au-delà de 16 Mio dès l'en-tête", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1);
    expect(codeOf(() => new FrameReader().push(header))).toBe('SIGNER_FRAME_TOO_LARGE');
  });

  it('applique la limite configurée (server.max_message_bytes)', () => {
    const header = (length: number) => {
      const buffer = Buffer.alloc(4);
      buffer.writeUInt32BE(length);
      return buffer;
    };
    expect(codeOf(() => new FrameReader(1024).push(header(1025)))).toBe('SIGNER_FRAME_TOO_LARGE');
    expect(new FrameReader(1024).push(header(1024))).toBeUndefined();
  });

  it('plafonne une limite configurée au-delà de 16 Mio', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1);
    expect(codeOf(() => new FrameReader(2 * MAX_FRAME_BYTES).push(header))).toBe('SIGNER_FRAME_TOO_LARGE');
  });

  it('refuse des octets après la trame (une requête par connexion)', () => {
    const frame = Buffer.concat([encodeFrame({ op: 'ping' }), Buffer.from('x')]);
    expect(codeOf(() => new FrameReader().push(frame))).toBe('SIGNER_FRAME_INVALID');
  });

  it('refuse un JSON invalide', () => {
    const body = Buffer.from('{pas du json');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    expect(codeOf(() => new FrameReader().push(Buffer.concat([header, body])))).toBe('SIGNER_FRAME_INVALID');
  });
});

describe('requêtes et réponses', () => {
  it("accepte ping et rien d'autre en M0", () => {
    expect(parseRequest({ op: 'ping' })).toEqual({ op: 'ping' });
    expect(codeOf(() => parseRequest({ op: 'sign', key: 'x' }))).toBe('SIGNER_UNKNOWN_OPERATION');
    expect(codeOf(() => parseRequest({ op: 'export-key' }))).toBe('SIGNER_UNKNOWN_OPERATION');
    expect(codeOf(() => parseRequest({ op: 'ping', extra: 1 }))).toBe('SIGNER_REQUEST_INVALID');
    expect(codeOf(() => parseRequest('ping'))).toBe('SIGNER_REQUEST_INVALID');
  });

  it('valide les réponses côté client', () => {
    expect(parseResponse({ ok: true, result: { pong: true } })).toEqual({ ok: true, result: { pong: true } });
    expect(parseResponse({ ok: false, error: { code: 'X', message: 'm' } }).ok).toBe(false);
    expect(codeOf(() => parseResponse({ ok: 'yes' }))).toBe('SIGNER_RESPONSE_INVALID');
  });
});
