import { describeKeyStoreContract } from '../../contracts/keystore.contract.js';
import { MemoryKeyStore } from '../../fakes/keystore.js';

describeKeyStoreContract(() => new MemoryKeyStore());
