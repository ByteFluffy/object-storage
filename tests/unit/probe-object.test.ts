import { describe, expect, it } from 'vitest';
import type { ObjectStat, StorageDriver } from '../../src/core/contracts.js';
import { StorageError } from '../../src/core/errors.js';
import { createMemoryDriver } from '../../src/drivers/memory.js';
import { sha256Checksum } from '../../src/io/hash.js';
import { checkBucket, checkObject } from '../../src/plugins/probe/index.js';

const CRC64 = '18446744073709551615';

function driver(overrides: Partial<StorageDriver> & Pick<StorageDriver, 'storageId'>): StorageDriver {
  const unexpected = async (): Promise<never> => {
    throw new Error('unexpected driver call');
  };
  return {
    storageId: overrides.storageId,
    capabilities: overrides.capabilities ?? {
      put: true,
      copy: false,
      conditionalWrite: { ifNoneMatch: false },
      checksums: ['sha256', 'crc64-ecma'],
      presignMethods: [],
      multipart: null,
    },
    put: overrides.put ?? unexpected,
    stat: overrides.stat ?? unexpected,
    read: overrides.read ?? unexpected,
    copy: overrides.copy ?? unexpected,
    delete: overrides.delete ?? unexpected,
  };
}

function record(inner: StorageDriver, calls: string[]): StorageDriver {
  return {
    storageId: inner.storageId,
    capabilities: inner.capabilities,
    async put(input) {
      calls.push(`put:${input.object.key}`);
      return inner.put(input);
    },
    async stat(ref) {
      calls.push(`stat:${ref.key}`);
      return inner.stat(ref);
    },
    async read(ref) {
      calls.push(`read:${ref.key}`);
      return inner.read(ref);
    },
    async copy(input) {
      calls.push(`copy:${input.to.key}`);
      return inner.copy(input);
    },
    async delete(ref) {
      calls.push(`delete:${ref.key}`);
      return inner.delete(ref);
    },
  };
}

describe('checkBucket', () => {
  it('stats only the caller probe key', async () => {
    const calls: string[] = [];
    const statResult: ObjectStat = {
      byteLength: 2,
      checksum: { algorithm: 'sha256', value: 'abc' },
      etag: 'etag-not-checksum',
    };
    const result = await checkBucket(
      driver({
        storageId: 'bucket-a',
        async stat(ref) {
          calls.push(`stat:${ref.storageId}:${ref.key}`);
          return statResult;
        },
      }),
      { probeKey: 'canary/caller-key', mode: 'stat' },
    );

    expect(calls).toEqual(['stat:bucket-a:canary/caller-key']);
    expect(result.status).toBe('passed');
    expect(result.checksum).toEqual({ algorithm: 'sha256', value: 'abc' });
    expect(JSON.stringify(result)).not.toContain('etag-not-checksum');
  });

  it('returns not_found when stat is null and does not write', async () => {
    const calls: string[] = [];
    const result = await checkBucket(
      driver({
        storageId: 'bucket-a',
        async stat(ref) {
          calls.push(`stat:${ref.key}`);
          return null;
        },
      }),
      { probeKey: 'missing-canary', mode: 'stat' },
    );

    expect(calls).toEqual(['stat:missing-canary']);
    expect(result.status).toBe('not_found');
  });

  it('keeps a forbidden stat error as forbidden', async () => {
    const result = await checkBucket(
      driver({
        storageId: 'bucket-a',
        async stat() {
          throw new StorageError('forbidden', 'stat denied');
        },
      }),
      { probeKey: 'canary', mode: 'stat' },
    );

    expect(result.status).toBe('forbidden');
    expect(result.status).not.toBe('not_found');
  });

  it('puts and deletes only the caller probe key', async () => {
    const inner = createMemoryDriver({ storageId: 'local' });
    const kept = new TextEncoder().encode('stay');
    await inner.put({
      object: { storageId: 'local', key: 'keep-me' },
      data: kept,
      checksum: sha256Checksum(kept),
    });
    const calls: string[] = [];
    const result = await checkBucket(record(inner, calls), {
      probeKey: 'caller/probe-key-9f3a',
      mode: 'write',
    });

    expect(result.status).toBe('passed');
    expect(calls).toEqual(['put:caller/probe-key-9f3a', 'delete:caller/probe-key-9f3a']);
    expect(await inner.stat({ storageId: 'local', key: 'caller/probe-key-9f3a' })).toBeNull();
    expect(await inner.stat({ storageId: 'local', key: 'keep-me' })).not.toBeNull();
  });

  it('does not delete when the probe put is forbidden', async () => {
    const calls: string[] = [];
    const result = await checkBucket(
      driver({
        storageId: 'local',
        async put(input) {
          calls.push(`put:${input.object.key}`);
          throw new StorageError('forbidden', 'put denied');
        },
        async delete(ref) {
          calls.push(`delete:${ref.key}`);
        },
      }),
      { probeKey: 'caller/probe-key-9f3a', mode: 'write' },
    );

    expect(result.status).toBe('forbidden');
    expect(result.status).not.toBe('not_found');
    expect(calls).toEqual(['put:caller/probe-key-9f3a']);
  });
});

describe('checkObject', () => {
  const ref = { storageId: 'local', key: 'photos/cat.bin' };

  it('returns not_found when stat is null', async () => {
    const result = await checkObject(
      driver({
        storageId: 'local',
        async stat() {
          return null;
        },
      }),
      { ref },
    );

    expect(result.status).toBe('not_found');
  });

  it('does not pass when the length matches but the checksum value differs', async () => {
    const result = await checkObject(
      driver({
        storageId: 'local',
        async stat() {
          return {
            byteLength: 4,
            checksum: { algorithm: 'sha256', value: 'aa' },
            etag: 'mem:aa:4',
          };
        },
      }),
      {
        ref,
        expectedByteLength: 4,
        expectedChecksum: { algorithm: 'sha256', value: 'bb' },
      },
    );

    expect(result.status).toBe('mismatch');
    expect(result.status).not.toBe('passed');
  });

  it('passes on checksum.value and keeps crc64 as a string', async () => {
    const result = await checkObject(
      driver({
        storageId: 'local',
        async stat() {
          return {
            byteLength: 8,
            checksum: { algorithm: 'crc64-ecma', value: CRC64 },
            etag: 'etag-not-checksum',
          };
        },
      }),
      {
        ref,
        expectedByteLength: 8,
        expectedChecksum: { algorithm: 'crc64-ecma', value: CRC64 },
      },
    );

    expect(result.status).toBe('passed');
    expect(result.checksum).toEqual({ algorithm: 'crc64-ecma', value: CRC64 });
    expect(typeof result.checksum?.value).toBe('string');
    expect(JSON.stringify(result)).not.toContain('etag-not-checksum');
  });

  it('does not treat an etag as the checksum', async () => {
    const etag = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const result = await checkObject(
      driver({
        storageId: 'local',
        async stat() {
          return { byteLength: 3, checksum: null, etag };
        },
      }),
      { ref, expectedChecksum: { algorithm: 'sha256', value: etag } },
    );

    expect(result.status).not.toBe('passed');
    expect(result.checksum).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(etag);
  });

  it('does not claim a match from byte length alone', async () => {
    const result = await checkObject(
      driver({
        storageId: 'local',
        async stat() {
          return {
            byteLength: 3,
            checksum: null,
            etag: 'etag-not-checksum',
          };
        },
      }),
      { ref, expectedByteLength: 3 },
    );

    expect(result.status).not.toBe('passed');
    expect(result.status === 'mismatch' || result.code === 'checksum_unavailable').toBe(true);
    expect(JSON.stringify(result)).not.toContain('etag-not-checksum');
  });

  it('keeps a forbidden stat error as forbidden', async () => {
    const result = await checkObject(
      driver({
        storageId: 'local',
        async stat() {
          throw new StorageError('forbidden', 'stat denied');
        },
      }),
      { ref },
    );

    expect(result.status).toBe('forbidden');
    expect(result.status).not.toBe('not_found');
  });
});
