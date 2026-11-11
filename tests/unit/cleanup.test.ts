import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ObjectRef, StorageDriver } from '../../src/core/contracts.js';
import { StorageError } from '../../src/core/errors.js';
import { createMemoryDriver } from '../../src/drivers/memory.js';
import { sha256Checksum } from '../../src/io/hash.js';
import { createWorkspace } from '../../src/io/workspace.js';
import { cleanObjects, cleanWorkspace } from '../../src/plugins/cleanup/index.js';

const STALE = new StorageError('stale_receipt', 'object generation does not match').code;

async function put(driver: StorageDriver, key: string, text: string): Promise<void> {
  const data = new TextEncoder().encode(text);
  await driver.put({
    object: { storageId: driver.storageId, key },
    data,
    checksum: sha256Checksum(data),
  });
}

describe('cleanObjects', () => {
  it('deletes only the current generation and leaves every other key', async () => {
    const inner = createMemoryDriver({ storageId: 'local' });
    await put(inner, 'keep', 'outside the list');
    await put(inner, 'matched', 'current');
    await put(inner, 'stale', 'old receipt');
    await put(inner, 'missing', 'no generation');
    const deleted: string[] = [];
    const driver: StorageDriver = {
      ...inner,
      async delete(ref) {
        deleted.push(ref.key);
        await inner.delete(ref);
      },
    };
    const generations = new Map<string, string | null>([
      ['matched', '3'],
      ['stale', '9'],
      ['missing', null],
    ]);
    const matched: ObjectRef = { storageId: 'local', key: 'matched' };
    const stale: ObjectRef = { storageId: 'local', key: 'stale' };
    const missing: ObjectRef = { storageId: 'local', key: 'missing' };

    const results = await cleanObjects({
      driver,
      items: [
        { ref: matched, generation: '3' },
        { ref: stale, generation: '8' },
        { ref: missing, generation: '3' },
      ],
      currentGeneration: async (ref) => generations.get(ref.key) ?? null,
    });

    expect(results).toEqual([
      { ref: matched, status: 'deleted' },
      { ref: stale, status: 'failed', code: STALE },
      { ref: missing, status: 'not_found' },
    ]);
    expect(deleted).toEqual(['matched']);
    expect(await inner.stat(matched)).toBeNull();
    expect(await inner.stat(stale)).not.toBeNull();
    expect(await inner.stat(missing)).not.toBeNull();
    expect(await inner.stat({ storageId: 'local', key: 'keep' })).not.toBeNull();
  });

  it('compares generations as strings so nearby crc-sized values stay distinct', async () => {
    const huge = '18446744073709551615';
    const near = '18446744073709551614';
    expect(Number(huge)).toBe(Number(near));

    const inner = createMemoryDriver({ storageId: 'local' });
    await put(inner, 'same', 'a');
    await put(inner, 'near', 'b');
    const deleted: string[] = [];
    const driver: StorageDriver = {
      ...inner,
      async delete(ref) {
        deleted.push(ref.key);
        await inner.delete(ref);
      },
    };

    await cleanObjects({
      driver,
      items: [
        { ref: { storageId: 'local', key: 'same' }, generation: huge },
        { ref: { storageId: 'local', key: 'near' }, generation: near },
      ],
      currentGeneration: () => huge,
    });

    expect(deleted).toEqual(['same']);
    expect(await inner.stat({ storageId: 'local', key: 'same' })).toBeNull();
    expect(await inner.stat({ storageId: 'local', key: 'near' })).not.toBeNull();
  });
});

describe('cleanWorkspace', () => {
  it('releases the workspace and leaves files outside it', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'object-storage-clean-'));
    const outside = join(parent, 'keep.txt');
    await writeFile(outside, 'keep me');
    const workspace = await createWorkspace(parent);
    const artifact = await workspace.writeArtifact('out.bin', new TextEncoder().encode('temp'));

    await cleanWorkspace(workspace);

    await expect(stat(workspace.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(artifact.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(outside, 'utf8')).toBe('keep me');
  });
});
