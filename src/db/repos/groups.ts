import type { Db } from '../connection.js';
import { all, first, qb, run } from '../query.js';
import type { Role } from '../schema.js';

// Groupes locaux, appartenances et rôles (ADR-0010) : les rôles ne s'attribuent qu'à des groupes,
// et les droits effectifs d'un compte sont l'union des rôles de ses groupes locaux et d'annuaire.

export interface NewLocalGroup {
  id: string;
  name: string;
  description?: string;
  breakGlass: boolean;
  now: number;
}

export function findLocalGroup(db: Db, name: string) {
  return first(db, qb.selectFrom('local_group').select(['id', 'name', 'break_glass']).where('name', '=', name));
}

/** Rend l'identifiant du groupe de ce nom (insensible à la casse), créé s'il n'existe pas. */
export function ensureLocalGroup(db: Db, group: NewLocalGroup): string {
  const existing = findLocalGroup(db, group.name);
  if (existing) return existing.id;
  run(
    db,
    qb.insertInto('local_group').values({
      id: group.id,
      name: group.name,
      description: group.description ?? '',
      break_glass: group.breakGlass ? 1 : 0,
      created_at: group.now,
    }),
  );
  return group.id;
}

export function addGroupMember(
  db: Db,
  member: { groupId: string; accountId: string; addedBy: string; now: number },
): void {
  run(
    db,
    qb
      .insertInto('local_group_member')
      .values({
        group_id: member.groupId,
        account_id: member.accountId,
        added_by: member.addedBy,
        added_at: member.now,
      })
      .onConflict((conflict) => conflict.doNothing()),
  );
}

export interface NewGroupRole {
  id: string;
  localGroupId: string;
  role: Role;
  repoId: string | null;
  createdBy: string;
  now: number;
}

/** Attribue un rôle à un groupe local, sans doublon. */
export function ensureGroupRole(db: Db, grant: NewGroupRole): void {
  const query = qb
    .selectFrom('group_role')
    .select('id')
    .where('group_kind', '=', 'local')
    .where('local_group_id', '=', grant.localGroupId)
    .where('role', '=', grant.role);
  const existing = first(
    db,
    grant.repoId === null ? query.where('repo_id', 'is', null) : query.where('repo_id', '=', grant.repoId),
  );
  if (existing) return;
  run(
    db,
    qb.insertInto('group_role').values({
      id: grant.id,
      group_kind: 'local',
      local_group_id: grant.localGroupId,
      directory_group_id: null,
      role: grant.role,
      repo_id: grant.repoId,
      created_by: grant.createdBy,
      created_at: grant.now,
    }),
  );
}

export interface EffectiveRole {
  role: Role;
  repoId: string | null;
}

/** Union des rôles des groupes locaux et d'annuaire (appartenances en cache) du compte. */
export function effectiveRoles(db: Db, accountId: string): EffectiveRole[] {
  const local = qb
    .selectFrom('group_role')
    .innerJoin('local_group_member', 'local_group_member.group_id', 'group_role.local_group_id')
    .select(['group_role.role as role', 'group_role.repo_id as repo_id'])
    .where('local_group_member.account_id', '=', accountId);
  const directory = qb
    .selectFrom('group_role')
    .innerJoin('account_directory_group', 'account_directory_group.directory_group_id', 'group_role.directory_group_id')
    .select(['group_role.role as role', 'group_role.repo_id as repo_id'])
    .where('account_directory_group.account_id', '=', accountId);
  const rows = all(db, local.union(directory).orderBy('role').orderBy('repo_id'));
  return rows.map((row) => ({ role: row.role, repoId: row.repo_id }));
}
