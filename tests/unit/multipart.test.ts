import { describe, expect, it } from 'vitest';
import { createMemoryDriver } from '../../src/drivers/memory.js';
import { abortMultipartPlan, completeMultipartPlan, createMultipartPlan } from '../../src/server/multipart.js';
import type { CreateMultipartInput, StorageDriver } from '../../src/core/contracts.js';

function multipartDriver(): {
  driver: StorageDriver;
  created: CreateMultipartInput[];
  completed: unknown[];
  aborted: unknown[];
} {
  const created: CreateMultipartInput[] = [];
  const completed: unknown[] = [];
  const aborted: unknown[] = [];
  const driver: StorageDriver = {
    storageId: 'cloud',
    capabilities: {
      put: true,
      copy: true,
      conditionalWrite: { ifNoneMatch: true },
      checksums: ['sha256'],
      presignMethods: ['PUT'],
      multipart: { minPartBytes: 5 * 1024 * 1024, maxPartBytes: 5 * 1024 * 1024 * 1024 },
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
    async createMultipart(input) {
      created.push(input);
      return { uploadId: 'up-1', partCount: 999 };
    },
    async completeMultipart(input) {
      completed.push(input);
      return { etag: '"done"' };
    },
    async abortMultipart(input) {
      aborted.push(input);
    },
  };
  return { driver, created, completed, aborted };
}

const object = { storageId: 'cloud', key: 'blob.bin' };

describe('multipart plans', () => {
  it('calculates partCount from the caller partSize and totalBytes', async () => {
    const { driver, created } = multipartDriver();
    await expect(
      createMultipartPlan(driver, { object, partSize: 100, totalBytes: 250, contentType: 'application/octet-stream' }),
    ).resolves.toEqual({ uploadId: 'up-1', partCount: 3 });
    expect(created[0]).toEqual({
      object,
      partSize: 100,
      totalBytes: 250,
      contentType: 'application/octet-stream',
    });
    expect(created[0]?.partSize).not.toBe(5 * 1024 * 1024);
    expect(created[0]?.partSize).not.toBe(20 * 1024 * 1024);

    const edges = multipartDriver();
    await expect(createMultipartPlan(edges.driver, { object, partSize: 100, totalBytes: 0 })).resolves.toMatchObject({
      partCount: 0,
    });
    await expect(createMultipartPlan(edges.driver, { object, partSize: 100, totalBytes: 100 })).resolves.toMatchObject({
      partCount: 1,
    });
    await expect(createMultipartPlan(edges.driver, { object, partSize: 100, totalBytes: 101 })).resolves.toMatchObject({
      partCount: 2,
    });
  });

  it('does not fill a default partSize or call the driver when partSize is missing', async () => {
    const { driver, created } = multipartDriver();
    await expect(
      createMultipartPlan(driver, { object, partSize: undefined as unknown as number, totalBytes: 100 }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    await expect(createMultipartPlan(driver, { object, partSize: 0, totalBytes: 100 })).rejects.toMatchObject({
      code: 'config_invalid',
    });
    expect(created).toEqual([]);
  });

  it('rejects a driver that cannot create a multipart upload', async () => {
    await expect(
      createMultipartPlan(createMemoryDriver({ storageId: 'local' }), {
        object: { storageId: 'local', key: 'a.bin' },
        partSize: 100,
        totalBytes: 100,
      }),
    ).rejects.toMatchObject({ code: 'capability_unsupported' });
  });

  it('rejects missing parts, duplicate part numbers, and empty etags without completing', async () => {
    const { driver, completed } = multipartDriver();
    const base = { object, uploadId: 'up-1', partCount: 2 };
    await expect(
      completeMultipartPlan(driver, { ...base, parts: [{ partNumber: 1, etag: '"a"' }] }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    await expect(
      completeMultipartPlan(driver, {
        ...base,
        parts: [
          { partNumber: 1, etag: '"a"' },
          { partNumber: 1, etag: '"b"' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    await expect(
      completeMultipartPlan(driver, {
        ...base,
        parts: [
          { partNumber: 1, etag: '' },
          { partNumber: 2, etag: '"b"' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    expect(completed).toEqual([]);
  });

  it('completes a valid part list and abort calls abortMultipart', async () => {
    const { driver, completed, aborted } = multipartDriver();
    await expect(
      completeMultipartPlan(driver, {
        object,
        uploadId: 'up-1',
        partCount: 2,
        parts: [
          { partNumber: 2, etag: '"p2"' },
          { partNumber: 1, etag: '"p1"' },
        ],
      }),
    ).resolves.toEqual({ etag: '"done"' });
    expect(completed).toEqual([
      {
        object,
        uploadId: 'up-1',
        parts: [
          { partNumber: 1, etag: '"p1"' },
          { partNumber: 2, etag: '"p2"' },
        ],
      },
    ]);

    await abortMultipartPlan(driver, { object, uploadId: 'up-1' });
    expect(aborted).toEqual([{ object, uploadId: 'up-1' }]);
  });

  it('does not abort when the driver has no abortMultipart', async () => {
    await expect(
      abortMultipartPlan(createMemoryDriver({ storageId: 'local' }), {
        object: { storageId: 'local', key: 'a.bin' },
        uploadId: 'up-1',
      }),
    ).rejects.toMatchObject({ code: 'capability_unsupported' });
  });
});
