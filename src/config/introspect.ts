import type { z } from 'zod';

/** Nature d'une clé terminale du schéma, utilisée pour convertir les variables d'environnement. */
export type LeafKind = 'string' | 'number' | 'boolean' | 'json';

interface Def {
  type: string;
  innerType?: z.ZodType;
  in?: z.ZodType;
  shape?: Record<string, z.ZodType>;
}

const defOf = (schema: z.ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def;

/** Retire les enveloppes (défaut, optionnel, transformation) pour atteindre le type saisi. */
function unwrap(schema: z.ZodType): z.ZodType {
  const def = defOf(schema);
  if ((def.type === 'default' || def.type === 'prefault' || def.type === 'optional') && def.innerType) {
    return unwrap(def.innerType);
  }
  if (def.type === 'pipe' && def.in) return unwrap(def.in);
  return schema;
}

function kindOf(type: string): LeafKind {
  if (type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'string' || type === 'enum' || type === 'literal') return 'string';
  return 'json';
}

/** Liste les clés terminales (« section.sous_section.cle ») d'un schéma d'objets imbriqués. */
export function schemaLeaves(schema: z.ZodType, prefix = ''): Map<string, LeafKind> {
  const leaves = new Map<string, LeafKind>();
  const inner = unwrap(schema);
  const def = defOf(inner);
  if (def.type !== 'object' || !def.shape) {
    leaves.set(prefix, kindOf(def.type));
    return leaves;
  }
  for (const [key, child] of Object.entries(def.shape)) {
    for (const [leaf, kind] of schemaLeaves(child, prefix ? `${prefix}.${key}` : key)) leaves.set(leaf, kind);
  }
  return leaves;
}
