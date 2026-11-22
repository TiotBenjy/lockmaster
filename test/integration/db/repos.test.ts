import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase } from '../../../src/db/connection.js';
import { migrateDatabase } from '../../../src/db/migrations.js';
import { createLocalAccount, findAccountByUsername } from '../../../src/db/repos/accounts.js';
import {
  addGroupMember,
  effectiveRoles,
  ensureGroupRole,
  ensureLocalGroup,
  findLocalGroup,
} from '../../../src/db/repos/groups.js';
import { getSetting, putSetting } from '../../../src/db/repos/settings.js';

let db: Db;
beforeEach(() => {
  db = openDatabase(':memory:', { create: true });
  migrateDatabase(db, 0);
});
afterEach(() => db.close());

const NOW = 1_800_000_000_000;

describe('comptes', () => {
  it('crée un compte local et le retrouve sans tenir compte de la casse', () => {
    createLocalAccount(db, { id: 'A1', username: 'Alice', passwordHash: 'scrypt$x', now: NOW });
    expect(findAccountByUsername(db, 'alice')).toMatchObject({
      id: 'A1',
      username: 'Alice',
      auth_source: 'local',
      disabled: 0,
      created_at: NOW,
    });
    expect(findAccountByUsername(db, 'bob')).toBeUndefined();
    expect(() => createLocalAccount(db, { id: 'A2', username: 'ALICE', passwordHash: 'h', now: NOW })).toThrow(
      /UNIQUE/,
    );
  });
});

describe('groupes et rôles (ADR-0010)', () => {
  beforeEach(() => {
    createLocalAccount(db, { id: 'A1', username: 'alice', passwordHash: 'h', now: NOW });
  });

  it('ensureLocalGroup est idempotent', () => {
    const first = ensureLocalGroup(db, { id: 'G1', name: 'admins-secours', breakGlass: true, now: NOW });
    const again = ensureLocalGroup(db, { id: 'G2', name: 'Admins-Secours', breakGlass: true, now: NOW });
    expect(first).toBe('G1');
    expect(again).toBe('G1');
    expect(findLocalGroup(db, 'admins-secours')).toMatchObject({ id: 'G1', break_glass: 1 });
  });

  it('droits effectifs : union des rôles des groupes du compte, rien sans groupe', () => {
    expect(effectiveRoles(db, 'A1')).toEqual([]);
    const admins = ensureLocalGroup(db, { id: 'G1', name: 'admins-secours', breakGlass: true, now: NOW });
    ensureGroupRole(db, { id: 'R1', localGroupId: admins, role: 'admin', repoId: null, createdBy: 'system', now: NOW });
    ensureGroupRole(db, { id: 'R2', localGroupId: admins, role: 'admin', repoId: null, createdBy: 'system', now: NOW });
    expect(effectiveRoles(db, 'A1')).toEqual([]);
    addGroupMember(db, { groupId: admins, accountId: 'A1', addedBy: 'system', now: NOW });
    expect(effectiveRoles(db, 'A1')).toEqual([{ role: 'admin', repoId: null }]);
  });
});

describe('réglages', () => {
  it('lit et remplace une valeur', () => {
    expect(getSetting(db, 'review.allow_self_approval')).toBeUndefined();
    putSetting(db, { key: 'review.allow_self_approval', value: '1', actor: 'A1', now: NOW });
    putSetting(db, { key: 'review.allow_self_approval', value: '0', actor: 'A1', now: NOW + 1 });
    expect(getSetting(db, 'review.allow_self_approval')).toBe('0');
  });
});
