import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { schemaLeaves } from '../../../src/config/introspect.js';
import { signerConfigSchema } from '../../../src/signer/config.js';
import { REPO_ROOT } from '../../helpers/run-script.js';

// Le schéma du signataire et deploy/signer.example.toml décrivent exactement les mêmes clés, avec
// les mêmes valeurs par défaut (même garantie que pour l'application).

const example = parseToml(readFileSync(join(REPO_ROOT, 'deploy/signer.example.toml'), 'utf8'));

function flatten(value: unknown, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      for (const [k, v] of flatten(child, prefix ? `${prefix}.${key}` : key)) out.set(k, v);
    }
  } else {
    out.set(prefix, value);
  }
  return out;
}

describe('schéma du signataire = deploy/signer.example.toml', () => {
  it("accepte le fichier d'exemple", () => {
    expect(signerConfigSchema.safeParse(example).error?.issues ?? []).toEqual([]);
  });

  it('documente exactement les clés du schéma', () => {
    expect([...flatten(example).keys()].sort()).toEqual([...schemaLeaves(signerConfigSchema).keys()].sort());
  });

  it("a pour défauts les valeurs du fichier d'exemple", () => {
    expect(Object.fromEntries(flatten(signerConfigSchema.parse({})))).toEqual(
      Object.fromEntries(flatten(signerConfigSchema.parse(example))),
    );
  });

  it.each([
    ['message au-delà de 16 Mio', { server: { max_message_bytes: 16 * 1024 * 1024 + 1 } }],
    ['Valid-Until au-delà de 30 jours', { limits: { max_valid_until_days: 31 } }],
    ['socket vide', { server: { socket: '' } }],
    ['groupe mal formé', { server: { socket_group: 'grp;rm' } }],
    ["clé de l'application", { http: { listen: ':8080' } }],
  ])('refuse : %s', (_label, input) => {
    expect(signerConfigSchema.safeParse(input).success).toBe(false);
  });
});
