import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createStorage } from '../../src/core/storage.js';
import { createMemoryDriver } from '../../src/drivers/memory.js';

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

async function sealedFixture() {
  const storage = createStorage({
    drivers: [createMemoryDriver({ storageId: 'local' })],
  });
  await storage.upload({
    storageId: 'local',
    key: 'temp/abc.txt',
    source: { kind: 'bytes', data: new TextEncoder().encode('abc') },
  });
  return storage;
}

describe('Storage.finalize', () => {
  it('copies a matching temp object to the final key and keeps the temp object', async () => {
    const storage = await sealedFixture();

    const sealed = await storage.finalize({
      storageId: 'local',
      tempKey: 'temp/abc.txt',
      finalKey: 'final/abc.txt',
      expectedChecksum: { algorithm: 'sha256', value: ABC_SHA256 },
    });

    expect(sealed.reused).toBe(false);
    expect(sealed.delivery).toEqual({ status: 'not_requested' });
    expect(sealed.object.key).toBe('final/abc.txt');
    const finalObject = await storage.read({ storageId: 'local', key: 'final/abc.txt' });
    const tempObject = await storage.read({ storageId: 'local', key: 'temp/abc.txt' });
    expect(new TextDecoder().decode(finalObject.data)).toBe('abc');
    expect(new TextDecoder().decode(tempObject.data)).toBe('abc');
  });

  it('reuses the final object when the same checksum is sealed again', async () => {
    const storage = await sealedFixture();
    const request = {
      storageId: 'local',
      tempKey: 'temp/abc.txt',
      finalKey: 'final/abc.txt',
      expectedChecksum: { algorithm: 'sha256' as const, value: ABC_SHA256 },
    };
    await storage.finalize(request);

    const second = await storage.finalize(request);

    expect(second.reused).toBe(true);
    expect(second.checksum?.value).toBe(ABC_SHA256);
  });

  it('does not replace a final object when the checksum differs', async () => {
    const storage = await sealedFixture();
    await storage.finalize({
      storageId: 'local',
      tempKey: 'temp/abc.txt',
      finalKey: 'final/abc.txt',
      expectedChecksum: { algorithm: 'sha256', value: ABC_SHA256 },
    });
    await storage.upload({
      storageId: 'local',
      key: 'temp/other.txt',
      source: { kind: 'bytes', data: new TextEncoder().encode('zzz') },
    });

    await expect(
      storage.finalize({
        storageId: 'local',
        tempKey: 'temp/other.txt',
        finalKey: 'final/abc.txt',
        expectedChecksum: {
          algorithm: 'sha256',
          value: createHash('sha256').update('zzz').digest('hex'),
        },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    const stored = await storage.read({ storageId: 'local', key: 'final/abc.txt' });
    expect(new TextDecoder().decode(stored.data)).toBe('abc');
  });

  it('rejects a temp object whose checksum does not match and writes nothing', async () => {
    const storage = await sealedFixture();

    await expect(
      storage.finalize({
        storageId: 'local',
        tempKey: 'temp/abc.txt',
        finalKey: 'final/abc.txt',
        expectedChecksum: { algorithm: 'sha256', value: '0'.repeat(64) },
      }),
    ).rejects.toMatchObject({ code: 'checksum_mismatch' });
    await expect(storage.stat({ storageId: 'local', key: 'final/abc.txt' })).resolves.toBeNull();
  });
});
