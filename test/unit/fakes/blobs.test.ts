import { describeBlobStoreContract } from '../../contracts/blob-store.contract.js';
import { MemoryBlobs } from '../../fakes/blobs.js';

describeBlobStoreContract(() => {
  const blobs = new MemoryBlobs();
  return { store: blobs, writer: blobs };
});
