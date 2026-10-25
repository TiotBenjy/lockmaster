import { closeSync, constants, fchownSync, openSync } from 'node:fs';
import { LockmasterError } from '../domain/errors.js';

// Changement d'identité de `lockmaster init` lancé en root. Toute opération dans data_dir, dossier
// que le compte du service peut modifier, se fait sous l'identité du service (uid, gid et groupes
// supplémentaires) : un lien qu'il y aurait posé ne donne alors accès qu'à ce qu'il peut déjà
// atteindre. Root ne garde que la création du dossier lui-même et la clé maîtresse (/etc).
// Aucun repli : si l'identité ne peut pas être changée et vérifiée, l'opération est refusée.

export interface Identity {
  uid: number;
  gid: number;
}

export interface Privileges {
  readonly superuser: Identity;
  /** Exécute `fn` avec l'identité effective du service, puis revient à root, même en cas d'erreur. */
  asService<T>(service: Identity, fn: () => T): T;
  /** Propriétaire d'un dossier que root vient de créer, ouvert sans suivre de lien. */
  chownDirectory(path: string, owner: Identity): void;
}

/** Sous-ensemble de `process` utilisé ; injectable pour les tests. */
export interface IdentityProcess {
  getgroups?: () => number[];
  setgroups?: (groups: number[]) => void;
  setegid?: (gid: number | string) => void;
  seteuid?: (uid: number | string) => void;
  geteuid: () => number;
  getegid: () => number;
}

function identityError(reason: string): LockmasterError {
  return new LockmasterError('PRIVILEGE_DROP_FAILED', `changement d'identité impossible : ${reason}`);
}

export function processPrivileges(proc: IdentityProcess = process as IdentityProcess): Privileges {
  const superuser = { uid: 0, gid: 0 };
  return {
    superuser,
    asService(service, fn) {
      const { getgroups, setgroups, setegid, seteuid } = proc;
      if (!getgroups || !setgroups || !setegid || !seteuid) throw identityError('fonctions absentes');
      const groups = getgroups();
      const restore = () => {
        seteuid(superuser.uid);
        setegid(superuser.gid);
        setgroups(groups);
      };
      setgroups([service.gid]);
      setegid(service.gid);
      seteuid(service.uid);
      try {
        if (proc.geteuid() !== service.uid || proc.getegid() !== service.gid) {
          throw identityError(`identité effective ${proc.geteuid()}:${proc.getegid()} au lieu du service`);
        }
        return fn();
      } finally {
        restore();
      }
    },
    chownDirectory(path, owner) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        fchownSync(fd, owner.uid, owner.gid);
      } finally {
        closeSync(fd);
      }
    },
  };
}
