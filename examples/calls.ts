import { assessDelivery } from '../dist/delivery/fit.js';
import { createMemoryDriver } from '../dist/drivers/memory.js';
import { createStorage } from '../dist/index.js';
import { createSingleGetPlan } from '../dist/server/index.js';
import type { StorageDriver } from '../dist/index.js';

const storage = createStorage({
  drivers: [createMemoryDriver({ storageId: 'local' })],
});

const uploaded = await storage.upload({
  storageId: 'local',
  key: 'temp/note.txt',
  contentType: 'text/plain',
  source: { kind: 'bytes', data: new TextEncoder().encode('abc') },
});

const fit = assessDelivery(
  { mediaType: 'image/png', byteLength: 120_000, width: 1600, height: 900 },
  { allowedMediaTypes: ['image/webp'], maxBytes: 80_000, maxEdge: 1280 },
);

const plan = await createSingleGetPlan(signingDriver(), {
  object: { storageId: 'local', key: uploaded.object.key },
  expiresInSeconds: 60,
});

console.log(uploaded.delivery.status, fit.status, fit.status === 'adapt' ? fit.operation : '', plan.method);

function signingDriver(): StorageDriver {
  return {
    storageId: 'local',
    capabilities: {
      put: true,
      copy: false,
      conditionalWrite: { ifNoneMatch: false },
      checksums: ['sha256'],
      presignMethods: ['GET', 'PUT'],
      multipart: null,
    },
    async put() {
      throw new Error('unused');
    },
    async stat() {
      return null;
    },
    async read() {
      throw new Error('unused');
    },
    async copy() {
      throw new Error('unused');
    },
    async delete() {
      throw new Error('unused');
    },
    async presignGet(input) {
      return {
        method: 'GET',
        url: `https://signed.example/${input.object.key}`,
        headers: {},
      };
    },
  };
}
