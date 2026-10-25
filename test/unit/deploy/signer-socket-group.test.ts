import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSignerConfig } from '../../../src/signer/config.js';

// Le signataire refuse de démarrer si le socket n'a pas le groupe attendu (server.socket_group).
// Chaque livrable conteneur doit donc poser ce groupe d'une façon que l'image sait résoudre :
//  - compose : numéro du groupe partagé (aucun nom dans le /etc/group de l'image) ;
//  - quadlet : vide, le groupe hôte du dossier setgid (keep-id ne transmet pas les noms de l'hôte).

const ROOT = join(import.meta.dirname, '../../..');
const ABSENT_FILE = join(ROOT, 'absent', 'signer.toml');

function effectiveSocketGroup(env: Record<string, string>): string {
  return loadSignerConfig({ path: ABSENT_FILE, env, explicit: false }).server.socket_group;
}

function composeSigner(): { gid: string; env: Record<string, string> } {
  const text = readFileSync(join(ROOT, 'deploy/compose.yaml'), 'utf8');
  const block = /^ {2}signer:.*\n((?: {4}.*\n|\s*\n)+)/m.exec(text)?.[1] ?? '';
  const gid = /^ {4}user: "\d+:(\d+)"/m.exec(block)?.[1] ?? 'absent';
  const env: Record<string, string> = {};
  for (const [, name, quoted, bare] of block.matchAll(/^ {6}(LOCKMASTER_SIGNER__\w+): (?:"([^"]*)"|(\S*))/gm)) {
    env[name as string] = quoted ?? bare ?? '';
  }
  return { gid, env };
}

function quadletEnv(): Record<string, string> {
  const text = readFileSync(join(ROOT, 'deploy/quadlet/lockmaster-signer/lockmaster-signer.container'), 'utf8');
  const env: Record<string, string> = {};
  for (const [, name, value] of text.matchAll(/^Environment=(LOCKMASTER_SIGNER__\w+)=(.*)$/gm)) {
    env[name as string] = value as string;
  }
  return env;
}

describe('groupe du socket du signataire dans les livrables conteneur', () => {
  it('compose : le numéro du groupe du conteneur signer', () => {
    const { gid, env } = composeSigner();
    expect(gid).toMatch(/^\d+$/);
    expect(effectiveSocketGroup(env)).toBe(gid);
  });

  it('quadlet : vide (groupe du dossier setgid)', () => {
    expect(effectiveSocketGroup(quadletEnv())).toBe('');
  });
});
