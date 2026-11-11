import { createStorage } from '../dist/index.js';
import { createMemoryDriver } from '../dist/drivers/memory.js';

const storage = createStorage({
  drivers: [createMemoryDriver({ storageId: 'local' })],
});

const uploaded = await storage.upload({
  storageId: 'local',
  key: 'temp/note.txt',
  source: { kind: 'bytes', data: new TextEncoder().encode('abc') },
  contentType: 'text/plain',
});

if (!uploaded.checksum) {
  throw new Error('upload did not return a checksum');
}

const sealed = await storage.finalize({
  storageId: 'local',
  tempKey: uploaded.object.key,
  finalKey: 'final/note.txt',
  expectedChecksum: uploaded.checksum,
});

console.log(uploaded.delivery.status, sealed.object.key, sealed.reused);
