import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createStorage } from '../../src/core/storage.js';
import { createMemoryDriver } from '../../src/drivers/memory.js';
import type { OpenReadResult, StorageDriver } from '../../src/core/contracts.js';

const bytes = (value: string) => new TextEncoder().encode(value);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
function source(values: string[], byteLength?: number) {
  let pulls = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    const value = values[pulls++];
    if (value === undefined) controller.close(); else controller.enqueue(bytes(value));
  }, cancel }, { highWaterMark: 0 });
  return { result: { body, ...(byteLength === undefined ? {} : { byteLength }), contentType: 'text/plain' },
    cancel, pulls: () => pulls };
}
async function helpers() { return import('../../src/io/read.js'); }

describe('shared bounded read ownership', () => {
  it.each([undefined, 3])('reads bytes with real SHA and content type for declared length %j', async byteLength => {
    const { openBoundedRead, readBytes } = await helpers(); const raw = source(['a', 'bc'], byteLength);
    const result = await readBytes(openBoundedRead(raw.result, { maxBytes: 3 }));
    expect(result).toEqual({ data: bytes('abc'), byteLength: 3, checksum: { algorithm: 'sha256', value: sha256('abc') }, contentType: 'text/plain' });
    expect(raw.result.body.locked).toBe(false); expect(raw.cancel).not.toHaveBeenCalled();
  });

  it.each([undefined, 0])('allows empty streams with a zero-byte budget and declaration %j', async byteLength => {
    const { openBoundedRead, readBytes } = await helpers(); const raw = source([], byteLength);
    expect(await readBytes(openBoundedRead(raw.result, { maxBytes: 0 }))).toMatchObject({ byteLength: 0, checksum: { value: sha256('') } });
    expect(raw.result.body.locked).toBe(false);
  });

  it('does not prefetch while the caller has not requested a chunk', async () => {
    const { openBoundedRead } = await helpers(); const raw = source(['ab', 'cd'], 4);
    const opened = openBoundedRead(raw.result, { maxBytes: 4 });
    expect(raw.pulls()).toBe(0);
    const reader = opened.body.getReader();
    expect((await reader.read()).value).toEqual(bytes('ab'));
    await new Promise(resolve => setImmediate(resolve));
    expect(raw.pulls()).toBe(1);
    await reader.cancel('caller stopped'); reader.releaseLock();
    expect(raw.cancel).toHaveBeenCalledExactlyOnceWith('caller stopped'); expect(raw.result.body.locked).toBe(false);
  });

  it('rejects a declared length above budget before pulling and closes the source', async () => {
    const { openBoundedRead } = await helpers(); const raw = source(['abc'], 3);
    expect(() => openBoundedRead(raw.result, { maxBytes: 2 })).toThrow(expect.objectContaining({ code: 'input_too_large' }));
    expect(raw.pulls()).toBe(0); expect(raw.cancel).toHaveBeenCalledOnce(); expect(raw.result.body.locked).toBe(false);
  });

  it('rejects unknown-length overflow chunk by chunk and closes without another read', async () => {
    const { openBoundedRead, readBytes } = await helpers(); const raw = source(['ab', 'cd', 'unread']);
    await expect(readBytes(openBoundedRead(raw.result, { maxBytes: 3 }))).rejects.toMatchObject({ code: 'input_too_large' });
    expect(raw.pulls()).toBe(2); expect(raw.cancel).toHaveBeenCalledOnce(); expect(raw.result.body.locked).toBe(false);
  });

  it.each([2, 4])('rejects a mismatched declared length %i', async byteLength => {
    const { openBoundedRead, readBytes } = await helpers(); const raw = source(['abc'], byteLength);
    await expect(readBytes(openBoundedRead(raw.result))).rejects.toMatchObject({ code: 'constraint_unsatisfied' });
    expect(raw.result.body.locked).toBe(false);
  });

  it.each([-1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid maxBytes %j and releases the raw reader', async maxBytes => {
    const { openBoundedRead } = await helpers(); const raw = source(['abc']);
    expect(() => openBoundedRead(raw.result, { maxBytes })).toThrow(expect.objectContaining({ code: 'config_invalid' }));
    expect(raw.cancel).toHaveBeenCalledOnce(); expect(raw.result.body.locked).toBe(false);
  });

  it.each([-1, NaN, 1.5])('rejects invalid response byteLength %j and releases the raw reader', async byteLength => {
    const { openBoundedRead } = await helpers(); const raw = source(['abc'], byteLength);
    expect(() => openBoundedRead(raw.result)).toThrow(expect.objectContaining({ code: 'config_invalid' }));
    expect(raw.cancel).toHaveBeenCalledOnce(); expect(raw.result.body.locked).toBe(false);
  });

  it('actively cancels a stalled source and rejects its pending read when the signal aborts', async () => {
    const { openBoundedRead } = await helpers(); const controller = new AbortController(); const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull() {}, cancel }, { highWaterMark: 0 });
    const reader = openBoundedRead({ body }, { signal: controller.signal }).body.getReader();
    const pending = reader.read(); controller.abort(new Error('caller stopped'));
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    reader.releaseLock(); expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
  });

  it('cancels and releases a raw stream even when its signal was already aborted', async () => {
    const { openBoundedRead } = await helpers(); const raw = source(['abc']);
    expect(() => openBoundedRead(raw.result, { signal: AbortSignal.abort() })).toThrow(expect.objectContaining({ code: 'cancelled' }));
    expect(raw.pulls()).toBe(0); expect(raw.cancel).toHaveBeenCalledOnce(); expect(raw.result.body.locked).toBe(false);
  });

  it('preserves the original source error rather than replacing it with cleanup failure', async () => {
    const { openBoundedRead, readBytes } = await helpers(); const original = new Error('source failed');
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(original); }, cancel() { throw new Error('cleanup failed'); } }, { highWaterMark: 0 });
    await expect(readBytes(openBoundedRead({ body }))).rejects.toBe(original);
    expect(body.locked).toBe(false);
  });

  it('keeps overflow as the error even when cancelling the source throws', async () => {
    const { openBoundedRead, readBytes } = await helpers();
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(bytes('abc')); },
      cancel() { throw new Error('cleanup failed'); } }, { highWaterMark: 0 });
    await expect(readBytes(openBoundedRead({ body }, { maxBytes: 2 }))).rejects.toMatchObject({ code: 'input_too_large' });
    expect(body.locked).toBe(false);
  });

  it('retains the same bytes used for SHA when a transport reuses its chunk buffer', async () => {
    const { openBoundedRead, readBytes } = await helpers(); const chunk = bytes('ab'); let produced = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (produced === 2) { controller.close(); return; }
      if (produced === 1) chunk.set(bytes('cd'));
      produced += 1; controller.enqueue(chunk);
    } }, { highWaterMark: 0 });
    expect(await readBytes(openBoundedRead({ body, byteLength: 4 }))).toMatchObject({ data: bytes('abcd'), checksum: { value: sha256('abcd') } });
  });
});

describe('Storage public object operations', () => {
  const ref = { storageId: 'memory', key: 'object' };
  async function fixture() {
    const driver = createMemoryDriver({ storageId: 'memory' }); const storage = createStorage({ drivers: [driver] });
    await storage.upload({ ...ref, source: { kind: 'bytes', data: bytes('abc') }, contentType: 'text/plain' });
    return { driver, storage };
  }

  it('reads the memory stream through the public byte budget and returns content type', async () => {
    const { storage } = await fixture();
    await expect(storage.read(ref, { maxBytes: 2 })).rejects.toMatchObject({ code: 'input_too_large' });
    await expect(storage.read(ref, { maxBytes: 3 })).resolves.toMatchObject({ data: bytes('abc'), byteLength: 3, contentType: 'text/plain', checksum: { value: sha256('abc') } });
  });

  it('has no whole-buffer fallback when streaming read is unsupported', async () => {
    const { driver } = await fixture(); const legacyRead = vi.fn(driver.read);
    const unsupported: StorageDriver = { ...driver, openRead: undefined, read: legacyRead };
    const storage = createStorage({ drivers: [unsupported] });
    await expect(storage.openRead(ref)).rejects.toMatchObject({ code: 'capability_unsupported' });
    await expect(storage.read(ref)).rejects.toMatchObject({ code: 'capability_unsupported' });
    expect(legacyRead).not.toHaveBeenCalled();
  });

  it('forwards one managed driver result and its complete read options without another wrapper', async () => {
    const { driver } = await fixture(); const raw = source(['abc'], 3);
    const openRead = vi.fn<NonNullable<StorageDriver['openRead']>>(async () => raw.result);
    const storage = createStorage({ drivers: [{ ...driver, openRead }] });
    const options = { maxBytes: 3, signal: new AbortController().signal };
    expect(await storage.openRead(ref, options)).toBe(raw.result);
    expect(openRead).toHaveBeenCalledExactlyOnceWith(ref, options);
    await raw.result.body.cancel();
  });

  it('forwards cancellation to HEAD and deletion, and memory rejects both without mutation', async () => {
    const { driver, storage } = await fixture(); const signal = AbortSignal.abort();
    await expect(storage.stat(ref, { signal })).rejects.toMatchObject({ code: 'cancelled' });
    await expect(storage.delete(ref, { signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(await storage.stat(ref)).not.toBeNull();
    await storage.delete(ref); expect(await storage.stat(ref)).toBeNull();
    await expect(driver.read(ref)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('forwards a live operation signal to the driver HEAD and delete calls', async () => {
    const { driver, storage } = await fixture(); const options = { signal: new AbortController().signal };
    const stat = vi.spyOn(driver, 'stat'); const remove = vi.spyOn(driver, 'delete');
    await storage.stat(ref, options); await storage.delete(ref, options);
    expect(stat).toHaveBeenCalledExactlyOnceWith(ref, options);
    expect(remove).toHaveBeenCalledExactlyOnceWith(ref, options);
  });

  it('enforces read budgets on the public memory driver without going through Storage', async () => {
    const { driver } = await fixture();
    await expect(driver.read(ref, { maxBytes: 2 })).rejects.toMatchObject({ code: 'input_too_large' });
    const opened = await driver.openRead!(ref, { signal: new AbortController().signal, maxBytes: 3 });
    const { readBytes } = await helpers();
    await expect(readBytes(opened)).resolves.toMatchObject({ data: bytes('abc'), checksum: { value: sha256('abc') } });
  });

  it('uses the same bounded read for finalize when a stat checksum is absent or the body grows', async () => {
    const { driver } = await fixture(); const copy = vi.fn(driver.copy);
    const raw = source(['abcd'], 4);
    const noChecksum = vi.fn(async () => ({ byteLength: 3, checksum: null, etag: 'etag' }));
    const { openBoundedRead } = await helpers();
    const openRead = vi.fn<NonNullable<StorageDriver['openRead']>>(async (_ref, options) => openBoundedRead(raw.result, options));
    const storage = createStorage({ drivers: [{ ...driver, stat: noChecksum, copy, openRead }] });
    await expect(storage.finalize({ storageId: 'memory', tempKey: 'object', finalKey: 'final',
      expectedChecksum: { algorithm: 'sha256', value: sha256('abc') }, maxReadBytes: 3,
    })).rejects.toMatchObject({ code: 'input_too_large' });
    expect(copy).not.toHaveBeenCalled(); expect(raw.cancel).toHaveBeenCalledOnce();
  });
});
