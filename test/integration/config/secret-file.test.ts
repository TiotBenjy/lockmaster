import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isInside } from '../../../src/config/real-path.js';
import { defaultAllowedGids, readSecretFile } from '../../../src/config/secret-file.js';
import { LockmasterError } from '../../../src/domain/errors.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lockmaster-secret-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function secret(name: string, content: string | Buffer, mode: number): string {
  const file = join(dir, name);
  writeFileSync(file, content);
  chmodSync(file, mode);
  return file;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof LockmasterError ? error.code : String(error);
  }
  return undefined;
}

describe('readSecretFile', () => {
  it.each([0o400, 0o440, 0o600, 0o640])('lit un fichier en mode %o appartenant au compte courant', (mode) => {
    expect(readSecretFile(secret('k', 'abc', mode)).toString()).toBe('abc');
  });

  it.each([0o644, 0o604, 0o602, 0o601])('refuse un fichier accessible à « others » (mode %o)', (mode) => {
    expect(codeOf(() => readSecretFile(secret('k', 'abc', mode)))).toBe('SECRET_FILE_PERMISSIONS');
  });

  it.each([0o620, 0o660, 0o420])('refuse un fichier modifiable par le groupe (mode %o)', (mode) => {
    expect(codeOf(() => readSecretFile(secret('k', 'abc', mode)))).toBe('SECRET_FILE_PERMISSIONS');
  });

  it('refuse un fichier lisible par un groupe non autorisé, accepte le même fichier sans droit de groupe', () => {
    const otherGid = (process.getgid?.() ?? 0) + 1;
    expect(codeOf(() => readSecretFile(secret('g', 'abc', 0o440), { allowedGids: [otherGid] }))).toBe(
      'SECRET_FILE_GROUP',
    );
    expect(readSecretFile(secret('h', 'abc', 0o400), { allowedGids: [otherGid] }).toString()).toBe('abc');
  });

  it('par défaut, seuls root et le groupe PRINCIPAL du service sont admis (pas ses groupes supplémentaires)', () => {
    // lockmaster et lockmaster-signer partagent le groupe supplémentaire lockmaster-sign (sysusers) :
    // une clé lisible par ce groupe serait lisible par les deux comptes.
    expect(defaultAllowedGids()).toEqual([0, process.getgid?.() ?? 0]);
  });

  it("refuse un fichier dont le propriétaire n'est ni root ni le compte courant", () => {
    const file = secret('k', 'abc', 0o400);
    const currentUid = process.getuid?.() ?? 0;
    expect(codeOf(() => readSecretFile(file, { allowedUids: [currentUid + 1] }))).toBe('SECRET_FILE_OWNER');
  });

  it('refuse un fichier absent, un dossier ou un fichier trop gros', () => {
    expect(codeOf(() => readSecretFile(join(dir, 'absent')))).toBe('SECRET_FILE_UNREADABLE');
    expect(codeOf(() => readSecretFile(dir))).toBe('SECRET_FILE_NOT_REGULAR');
    expect(codeOf(() => readSecretFile(secret('big', Buffer.alloc(70_000), 0o400)))).toBe('SECRET_FILE_TOO_LARGE');
  });

  it("contrôle la cible d'un lien symbolique, pas le lien", () => {
    const target = secret('cible', 'abc', 0o644);
    const link = join(dir, 'lien');
    symlinkSync(target, link);
    expect(codeOf(() => readSecretFile(link))).toBe('SECRET_FILE_PERMISSIONS');
  });

  it("le message d'erreur ne contient jamais le contenu du fichier", () => {
    const file = secret('k', 'contenu-tres-secret', 0o644);
    try {
      readSecretFile(file);
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('contenu-tres-secret');
    }
  });
});

describe('isInside', () => {
  it.each([
    ['/var/lib/lockmaster', '/var/lib/lockmaster/master.key', true],
    ['/var/lib/lockmaster', '/var/lib/lockmaster', true],
    ['/var/lib/lockmaster/', '/var/lib/lockmaster/a/../b.key', true],
    ['/var/lib/lockmaster', '/var/lib/lockmaster-keys/master.key', false],
    ['/var/lib/lockmaster', '/etc/lockmaster/master.key', false],
    ['/var/lib/lockmaster', '/var/lib/lockmaster/../x.key', false],
    ['/var/lib/lockmaster', '/var/lib/lockmaster/..cache/master.key', true],
  ])('%s contient %s : %s', (parent, child, expected) => {
    expect(isInside(parent, child)).toBe(expected);
  });
});
