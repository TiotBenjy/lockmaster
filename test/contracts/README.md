# Suites de conformité (substitution de Liskov)

Une suite par interface de `docs/01` §6, dans `<interface>.contract.ts`, sous la forme d'une fonction
`describe<Interface>Contract(factory)` qui décrit le comportement attendu de **toute** implémentation.

Chaque implémentation (`src/`) et chaque faux (`test/fakes/`) a un test qui importe son module et
appelle la suite de son interface :

```ts
import { FsBlobStore } from '../../../src/storage/fs-blobs.js';
import { describeBlobStoreContract } from '../../contracts/blob-store.contract.js';

describeBlobStoreContract(() => new FsBlobStore(tmpDir()));
```

`registry.json` associe le nom de l'interface au nom de sa suite. Quand une interface est ajoutée :
écrire sa suite, l'inscrire dans le registre. `scripts/check-contracts.mjs` (CI) refuse alors toute
classe `implements <Interface>` ou tout objet `satisfies <Interface>` sans test appelant la suite.
