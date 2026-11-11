import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorage } from '../../src/core/storage.js';
import { createMemoryDriver } from '../../src/drivers/memory.js';
import type { StorageDriver } from '../../src/core/contracts.js';

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function blockingDriver(storageId: string): StorageDriver {
  return {
    storageId,
    capabilities: {
      put: false,
      copy: false,
      conditionalWrite: { ifNoneMatch: false },
      checksums: [],
      presignMethods: [],
      multipart: null,
    },
    async put() {
      throw new Error('put was called');
    },
    async stat() {
      throw new Error('stat was called');
    },
    async copy() {
      throw new Error('copy was called');
    },
    async read() {
      throw new Error('read was called');
    },
    async delete() {
      throw new Error('delete was called');
    },
  };
}

describe('Storage.upload', () => {
  it('stores bytes and reports the upload as unverified', async () => {
    const storage = createStorage({
      drivers: [createMemoryDriver({ storageId: 'local' })],
    });

    const uploaded = await storage.upload({
      storageId: 'local',
      key: 'incoming/abc.txt',
      source: { kind: 'bytes', data: new TextEncoder().encode('abc') },
      contentType: 'text/plain',
    });

    expect(uploaded.delivery).toEqual({ status: 'not_requested' });
    expect(uploaded.reused).toBe(false);
    expect(uploaded.byteLength).toBe(3);
    expect(uploaded.checksum).toEqual({ algorithm: 'sha256', value: ABC_SHA256 });
    expect(uploaded.etag).not.toBe(uploaded.checksum?.value);
    expect(uploaded.object).toEqual({ storageId: 'local', key: 'incoming/abc.txt' });

    const stored = await storage.read({ storageId: 'local', key: 'incoming/abc.txt' });
    expect(new TextDecoder().decode(stored.data)).toBe('abc');
  });

  it('accepts a zero-byte object', async () => {
    const storage = createStorage({
      drivers: [createMemoryDriver({ storageId: 'local' })],
    });

    const uploaded = await storage.upload({
      storageId: 'local',
      key: 'incoming/empty.bin',
      source: { kind: 'bytes', data: new Uint8Array() },
    });

    expect(uploaded.byteLength).toBe(0);
    expect(uploaded.checksum?.value).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('rejects an empty key before calling the driver', async () => {
    const storage = createStorage({ drivers: [blockingDriver('local')] });

    await expect(
      storage.upload({
        storageId: 'local',
        key: '',
        source: { kind: 'bytes', data: new Uint8Array([1]) },
      }),
    ).rejects.toMatchObject({ code: 'empty_key' });
  });

  it('rejects a missing driver before reading the source', async () => {
    const storage = createStorage({ drivers: [] });
    let read = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          read = true;
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );

    await expect(
      storage.upload({
        storageId: 'missing',
        key: 'a.bin',
        source: { kind: 'stream', stream },
      }),
    ).rejects.toMatchObject({ code: 'config_missing' });
    expect(read).toBe(false);
  });

  it('rejects an unsupported operation before reading the source', async () => {
    const storage = createStorage({ drivers: [blockingDriver('local')] });
    let read = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          read = true;
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );

    await expect(
      storage.upload({
        storageId: 'local',
        key: 'a.bin',
        source: { kind: 'stream', stream, declaredByteLength: 1 },
        multipart: 'required',
      }),
    ).rejects.toMatchObject({ code: 'capability_unsupported' });
    expect(read).toBe(false);
  });

  it('does not store bytes when the expected checksum differs', async () => {
    const storage = createStorage({
      drivers: [createMemoryDriver({ storageId: 'local' })],
    });

    await expect(
      storage.upload({
        storageId: 'local',
        key: 'incoming/abc.txt',
        source: { kind: 'bytes', data: new TextEncoder().encode('abc') },
        expectedChecksum: { algorithm: 'sha256', value: '0'.repeat(64) },
      }),
    ).rejects.toMatchObject({ code: 'checksum_mismatch' });

    await expect(storage.stat({ storageId: 'local', key: 'incoming/abc.txt' })).resolves.toBeNull();
  });

  it('keeps the existing object when if-none-match fails', async () => {
    const storage = createStorage({
      drivers: [createMemoryDriver({ storageId: 'local' })],
    });
    await storage.upload({
      storageId: 'local',
      key: 'final/a.txt',
      source: { kind: 'bytes', data: new TextEncoder().encode('abc') },
    });

    await expect(
      storage.upload({
        storageId: 'local',
        key: 'final/a.txt',
        source: { kind: 'bytes', data: new TextEncoder().encode('zzz') },
        precondition: { ifNoneMatch: '*' },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    const stored = await storage.read({ storageId: 'local', key: 'final/a.txt' });
    expect(new TextDecoder().decode(stored.data)).toBe('abc');
  });

  it('does not store an object when the signal is already aborted', async () => {
    const storage = createStorage({
      drivers: [createMemoryDriver({ storageId: 'local' })],
    });
    const signal = AbortSignal.abort();

    await expect(
      storage.upload({
        storageId: 'local',
        key: 'incoming/late.bin',
        source: { kind: 'bytes', data: new Uint8Array([1, 2, 3]) },
        signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    await expect(storage.stat({ storageId: 'local', key: 'incoming/late.bin' })).resolves.toBeNull();
  });

  it('does not delete the caller file after uploading it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'object-storage-src-'));
    const filePath = join(directory, 'input.txt');
    await writeFile(filePath, 'abc');
    const storage = createStorage({
      drivers: [createMemoryDriver({ storageId: 'local' })],
    });

    await storage.upload({
      storageId: 'local',
      key: 'incoming/from-file.txt',
      source: { kind: 'file', path: filePath },
    });

    expect(await readFile(filePath, 'utf8')).toBe('abc');
    const digest = createHash('sha256').update('abc').digest('hex');
    expect(digest).toBe(ABC_SHA256);
  });
});
