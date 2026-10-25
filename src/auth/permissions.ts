// Permissions atomiques (docs/02 §3.5) : liste fermée. Une route ne peut déclarer que l'une d'elles.

export const PERMISSIONS = [
  'repo:read',
  'pkg:upload',
  'pkg:delete',
  'pkg:promote',
  'review:decide',
  'waiver:manage',
  'policy:manage',
  'repo:manage',
  'source:manage',
  'import:run',
  'key:manage',
  'user:manage',
  'audit:read',
  'settings:manage',
  'system:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}
