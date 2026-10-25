import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// SEC-29 et ADR-0009 sur les unités livrées : durcissement explicite, clé maîtresse de l'application
// transmise par systemd (LoadCredential, chiffrable par le drop-in d'exemple), signataire sans réseau.
// La validité réelle des unités est vérifiée en CI par systemd-analyze verify et security.

const ROOT = join(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const lines = (path: string) =>
  read(path)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

const SERVICES = ['packaging/systemd/lockmaster.service', 'packaging/systemd/lockmaster-signer.service'];
const HARDENING = [
  'NoNewPrivileges=yes',
  'ProtectSystem=strict',
  'ProtectKernelTunables=yes',
  'ProtectKernelModules=yes',
  'ProtectKernelLogs=yes',
  'ProtectControlGroups=yes',
  'RestrictNamespaces=yes',
  'LockPersonality=yes',
  'SystemCallArchitectures=native',
  'ProtectProc=invisible',
  'CapabilityBoundingSet=',
];

describe('unités systemd livrées', () => {
  it.each(SERVICES)('%s : directives de durcissement de SEC-29', (unit) => {
    const directives = lines(unit);
    for (const directive of HARDENING) expect(directives, directive).toContain(directive);
  });

  it('lockmaster.service reçoit la clé maîtresse par LoadCredential, jamais lue dans /etc par le service', () => {
    const directives = lines('packaging/systemd/lockmaster.service');
    expect(directives).toContain('LoadCredential=master.key:/etc/lockmaster/master.key');
    expect(directives).toContain('Environment=LOCKMASTER__SECURITY__MASTER_KEY_FILE=%d/master.key');
  });

  it("le drop-in d'exemple remplace la clé en clair par la clé chiffrée", () => {
    const directives = lines('packaging/examples/master-key-credential.conf');
    const reset = directives.indexOf('LoadCredential=');
    expect(reset).toBeGreaterThan(-1);
    expect(directives.indexOf('LoadCredentialEncrypted=master.key:/etc/lockmaster/master.key.cred')).toBeGreaterThan(
      reset,
    );
  });

  it("le signataire n'a aucun réseau (ADR-0009)", () => {
    const directives = lines('packaging/systemd/lockmaster-signer.service');
    expect(directives).toContain('PrivateNetwork=yes');
    expect(directives).toContain('IPAddressDeny=any');
    expect(directives).toContain('RestrictAddressFamilies=AF_UNIX');
  });
});
