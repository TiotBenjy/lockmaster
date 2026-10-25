import { lchownSync } from 'node:fs';

// Changement d'identité de `lockmaster init` lancé en root. Toute opération dans data_dir, dossier
// que le compte du service peut modifier, se fait sous l'identité du service (uid, gid et groupes
// supplémentaires) : un lien qu'il y aurait posé ne donne alors accès qu'à ce qu'il peut déjà
// atteindre. Root ne garde que la création du dossier lui-même et la clé maîtresse (/etc).

export interface Identity {
  uid: number;
  gid: number;
}

export interface Privileges {
  readonly superuser: Identity;
  /** Exécute `fn` avec l'identité effective du service, puis revient à root, même en cas d'erreur. */
  asService<T>(service: Identity, fn: () => T): T;
  /** Propriétaire d'un dossier que root vient de créer (jamais un lien). */
  chown(path: string, owner: Identity): void;
}

export function processPrivileges(): Privileges {
  return {
    superuser: { uid: 0, gid: 0 },
    asService(service, fn) {
      const groups = process.getgroups?.() ?? [];
      process.setgroups?.([service.gid]);
      process.setegid?.(service.gid);
      process.seteuid?.(service.uid);
      try {
        return fn();
      } finally {
        process.seteuid?.(0);
        process.setegid?.(0);
        process.setgroups?.(groups);
      }
    },
    chown(path, owner) {
      lchownSync(path, owner.uid, owner.gid);
    },
  };
}
