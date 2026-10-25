import { readFileSync } from 'node:fs';
import { LockmasterError } from '../domain/errors.js';
import { resolveGroup } from '../system/groups.js';

// Comptes système (créés par systemd-sysusers, packaging/sysusers/lockmaster.conf), lus dans
// /etc/passwd et /etc/group sans outil externe. Utilisé par `lockmaster init` lancé en root.

function field(file: string, name: string, index: number): number {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const parts = line.split(':');
    if (parts[0] === name && parts[index] !== undefined && /^\d+$/.test(parts[index])) return Number(parts[index]);
  }
  throw new LockmasterError('ACCOUNT_MISSING', `compte ou groupe système « ${name} » absent (${file})`);
}

export interface SystemAccounts {
  userIds(name: string): { uid: number; gid: number };
  groupId(name: string): number;
}

export function systemAccounts(passwd = '/etc/passwd', group = '/etc/group'): SystemAccounts {
  return {
    userIds: (name) => ({ uid: field(passwd, name, 2), gid: field(passwd, name, 3) }),
    groupId: (name) => resolveGroup(name, group),
  };
}
