import { describe, expect, it } from 'vitest';
import { createMemoryDriver } from '../../src/drivers/memory.js';
import { createSinglePutPlan } from '../../src/server/direct-upload.js';
import type { DirectUploadPlan, Source, StorageDriver } from '../../src/core/contracts.js';

function unreadStream(): { source: Source; pulled: () => boolean } {
  let pulled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return { source: { kind: 'stream', stream, declaredByteLength: 1 }, pulled: () => pulled };
}

function presigningDriver(): { driver: StorageDriver; calls: unknown[] } {
  const calls: unknown[] = [];
  const driver: StorageDriver = {
    storageId: 'cloud',
    capabilities: {
      put: true,
      copy: true,
      conditionalWrite: { ifNoneMatch: true },
      checksums: ['sha256'],
      presignMethods: ['GET', 'PUT'],
      multipart: null,
    },
    async put() {
      throw new Error('put was called');
    },
    async stat() {
      return null;
    },
    async read() {
      throw new Error('read was called');
    },
    async copy() {
      throw new Error('copy was called');
    },
    async delete() {
      throw new Error('delete was called');
    },
    async presignPut(input) {
      calls.push(input);
      const plan: DirectUploadPlan = {
        method: 'PUT',
        url: 'https://signed.example/object',
        headers: input.contentType === undefined ? {} : { 'content-type': input.contentType },
      };
      return plan;
    },
  };
  return { driver, calls };
}

describe('createSinglePutPlan', () => {
  it('calls presignPut and does not read the source stream', async () => {
    const { driver, calls } = presigningDriver();
    const source = unreadStream();
    const plan = await createSinglePutPlan(driver, {
      object: { storageId: 'cloud', key: 'a.bin' },
      contentType: 'application/octet-stream',
      expiresInSeconds: 60,
      source: source.source,
    });
    expect(plan).toEqual({
      method: 'PUT',
      url: 'https://signed.example/object',
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(calls).toEqual([
      {
        object: { storageId: 'cloud', key: 'a.bin' },
        contentType: 'application/octet-stream',
        expiresInSeconds: 60,
      },
    ]);
    expect(source.pulled()).toBe(false);
  });

  it('rejects a driver without presignPut before reading the source', async () => {
    const source = unreadStream();
    await expect(
      createSinglePutPlan(createMemoryDriver({ storageId: 'local' }), {
        object: { storageId: 'local', key: 'a.bin' },
        expiresInSeconds: 60,
        source: source.source,
      }),
    ).rejects.toMatchObject({ code: 'capability_unsupported' });
    expect(source.pulled()).toBe(false);
  });

  it('rejects HEAD presign before reading the source or calling presignPut', async () => {
    const { driver, calls } = presigningDriver();
    const source = unreadStream();
    await expect(
      createSinglePutPlan(driver, {
        method: 'HEAD',
        object: { storageId: 'cloud', key: 'a.bin' },
        expiresInSeconds: 60,
        source: source.source,
      }),
    ).rejects.toMatchObject({ code: 'capability_unsupported' });
    expect(calls).toEqual([]);
    expect(source.pulled()).toBe(false);
  });
});
