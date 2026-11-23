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
  const identity = {
    repoName: 'debian-12',
    repoFormat: 'deb',
    originLabel: 'lockmaster-debian-12',
    allowedNames: ['*'],
  };
  const valid = [
    { op: 'ping' },
    { op: 'status' },
    { op: 'list-keys' },
    { op: 'generate-key', purpose: 'repo', kind: 'openpgp', identity },
    { op: 'generate-key', purpose: 'repo', kind: 'openpgp', algorithm: 'ed25519', identity },
    { op: 'generate-key', purpose: 'repo', kind: 'apk-rsa', identity: { ...identity, repoFormat: 'apk' } },
    { op: 'generate-key', purpose: 'audit' },
    { op: 'rotate-key', keyId: '01JKEY' },
    { op: 'retire-key', keyId: '01JKEY' },
    { op: 'log', afterSeq: 0, limit: 100 },
    {
      op: 'sign',
      keyId: '01JKEY',
      kind: 'apt-release',
      content: 'Origin: x\n',
      context: { repo: 'debian-12', channel: 'stable', generation: 42 },
    },
    { op: 'sign', keyId: '01JKEY', kind: 'audit-checkpoint', checkpoint: { seq: 7, hash: 'a'.repeat(64), at: 1 } },
  ];

  it.each(valid)('accepte $op tel quel', (request) => {
    expect(parseRequest(request)).toEqual(request);
  });

  it('refuse toute opération inconnue', () => {
    expect(codeOf(() => parseRequest({ op: 'export-key' }))).toBe('SIGNER_UNKNOWN_OPERATION');
    expect(codeOf(() => parseRequest('ping'))).toBe('SIGNER_REQUEST_INVALID');
  });

  it.each([
    ['type de signature inconnu', { op: 'sign', keyId: 'k', kind: 'raw', content: 'x' }],
    [
      'contenu vide',
      { op: 'sign', keyId: 'k', kind: 'apt-release', content: '', context: { repo: 'r', channel: 'c', generation: 1 } },
    ],
    ['contexte incomplet', { op: 'sign', keyId: 'k', kind: 'apt-release', content: 'x', context: { repo: 'r' } }],
    [
      'point de contrôle avec champ en trop',
      {
        op: 'sign',
        keyId: 'k',
        kind: 'audit-checkpoint',
        checkpoint: { seq: 1, hash: 'a'.repeat(64), at: 0, extra: 1 },
      },
    ],
    [
      'hachage de point de contrôle mal formé',
      { op: 'sign', keyId: 'k', kind: 'audit-checkpoint', checkpoint: { seq: 1, hash: 'abc', at: 0 } },
    ],
  ])('refuse une demande de signature mal formée : %s', (_label, request) => {
    expect(codeOf(() => parseRequest(request))).toBe('SIGNER_REQUEST_INVALID');
  });

  it.each([
    ['champ en trop', { op: 'ping', extra: 1 }],
    ['clé privée fournie', { op: 'generate-key', purpose: 'audit', privateKey: 'x' }],
    ["identité pour la clé d'audit", { op: 'generate-key', purpose: 'audit', identity }],
    ['clé de dépôt sans identité', { op: 'generate-key', purpose: 'repo', kind: 'openpgp' }],
    ['type de clé inconnu', { op: 'generate-key', purpose: 'repo', kind: 'dsa', identity }],
    ['identifiant de clé mal formé', { op: 'rotate-key', keyId: '../x' }],
    ['identité modifiée par rotation', { op: 'rotate-key', keyId: 'k', identity }],
    ['tranche de journal trop grande', { op: 'log', afterSeq: 0, limit: 1001 }],
    ['numéro négatif', { op: 'log', afterSeq: -1, limit: 1 }],
    [
      'motifs de noms démesurés',
      {
        op: 'generate-key',
        purpose: 'repo',
        kind: 'openpgp',
        identity: { ...identity, allowedNames: Array.from({ length: 300 }, () => 'a') },
      },
    ],
  ])('refuse une requête mal formée : %s', (_label, request) => {
    expect(codeOf(() => parseRequest(request))).toBe('SIGNER_REQUEST_INVALID');
  });

  it('valide les réponses côté client', () => {
    expect(parseResponse({ ok: true, result: { pong: true } })).toEqual({ ok: true, result: { pong: true } });
    expect(parseResponse({ ok: false, error: { code: 'X', message: 'm' } }).ok).toBe(false);
    expect(codeOf(() => parseResponse({ ok: 'yes' }))).toBe('SIGNER_RESPONSE_INVALID');
  });
});
