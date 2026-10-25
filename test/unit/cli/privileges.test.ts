import { describe, expect, it } from 'vitest';
import { type IdentityProcess, processPrivileges } from '../../../src/cli/privileges.js';

// Implémentation réelle de asService, sur un « process » simulé : ordre des changements d'identité,
// retour à root même après une erreur, et refus (jamais de repli en root) si le changement échoue.

function fakeProcess(overrides: Partial<IdentityProcess> = {}) {
  const calls: string[] = [];
  let euid = 0;
  let egid = 0;
  const proc: IdentityProcess = {
    getgroups: () => [0, 4],
    setgroups: (groups) => calls.push(`setgroups:${groups.join(',')}`),
    setegid: (gid) => {
      calls.push(`setegid:${gid}`);
      egid = Number(gid);
    },
    seteuid: (uid) => {
      calls.push(`seteuid:${uid}`);
      euid = Number(uid);
    },
    geteuid: () => euid,
    getegid: () => egid,
    ...overrides,
  };
  return { proc, calls };
}

const service = { uid: 990, gid: 991 };

describe('processPrivileges().asService', () => {
  it("abandonne groupes, gid puis uid ; revient à root dans l'ordre inverse", () => {
    const { proc, calls } = fakeProcess();
    const seen = processPrivileges(proc).asService(service, () => [proc.geteuid(), proc.getegid()]);
    expect(seen).toEqual([990, 991]);
    expect(calls).toEqual(['setgroups:991', 'setegid:991', 'seteuid:990', 'seteuid:0', 'setegid:0', 'setgroups:0,4']);
  });

  it('revient à root même si la fonction lève une erreur', () => {
    const { proc, calls } = fakeProcess();
    expect(() =>
      processPrivileges(proc).asService(service, () => {
        throw new Error('échec');
      }),
    ).toThrow('échec');
    expect(calls.slice(-3)).toEqual(['seteuid:0', 'setegid:0', 'setgroups:0,4']);
  });

  it("refuse, sans exécuter la fonction, si l'identité effective n'a pas changé", () => {
    const { proc } = fakeProcess({ seteuid: () => {} });
    let ran = false;
    expect(() =>
      processPrivileges(proc).asService(service, () => {
        ran = true;
      }),
    ).toThrow(/identité/);
    expect(ran).toBe(false);
  });

  it("refuse si les fonctions de changement d'identité sont absentes", () => {
    const { proc } = fakeProcess();
    delete proc.seteuid;
    expect(() => processPrivileges(proc).asService(service, () => 1)).toThrow(/identité/);
  });
});
