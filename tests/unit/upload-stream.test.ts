import { createHash } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createStorage } from '../../src/core/storage.js';
import { createMemoryDriver } from '../../src/drivers/memory.js';
import type { StorageDriver, UploadRequest } from '../../src/core/contracts.js';

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

const options = { thresholdBytes: 6, partSizeBytes: 4 };
const bytes = (value: string) => new TextEncoder().encode(value);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function setup(multipart = true, overrides: Partial<StorageDriver> = {}) {
  const parts: Uint8Array[] = [];
  const put = vi.fn<StorageDriver['put']>(async () => ({ etag: 'put', checksum: null }));
  const create = vi.fn<NonNullable<StorageDriver['createMultipart']>>(async () => ({ uploadId: 'session' }));
  const part = vi.fn<NonNullable<StorageDriver['uploadPart']>>(async input => {
    parts.push(input.data.slice());
    return { etag: `part-${input.partNumber}` };
  });
  const complete = vi.fn<NonNullable<StorageDriver['completeMultipart']>>(async () => ({ etag: 'complete' }));
  const abort = vi.fn<NonNullable<StorageDriver['abortMultipart']>>(async () => {});
  const driver: StorageDriver = { ...createMemoryDriver({ storageId: 'cloud' }),
    capabilities: { put: true, copy: true, conditionalWrite: { ifNoneMatch: true }, checksums: ['sha256'], presignMethods: [],
      multipart: multipart ? { minPartBytes: 2, maxPartBytes: 64 * 1024 * 1024 } : null },
    put, createMultipart: create, uploadPart: part, completeMultipart: complete, abortMultipart: abort,
    ...overrides,
  };
  const storage = createStorage({ drivers: [driver] });
  const request = (source: UploadRequest['source'], overrides: Partial<UploadRequest> = {}): UploadRequest => ({
    storageId: 'cloud', key: 'result.bin', source, multipartOptions: options, ...overrides,
  });
  return { storage, request, driver, parts, put, create, part, complete, abort };
}
function streamed(values: string[]) {
  let pulls = 0;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const value = values[pulls++];
      if (value === undefined) controller.close(); else controller.enqueue(bytes(value));
    }, cancel,
  }, { highWaterMark: 0 });
  return { stream, cancel, pulls: () => pulls };
}

describe('bounded Storage.upload', () => {
  it.each(['bytes', 'stream'] as const)('keeps below-threshold %s on one conditional put', async kind => {
    const f = setup(); const progress = vi.fn();
    const result = await f.storage.upload(f.request(kind === 'bytes' ? { kind, data: bytes('abcde') }
      : { kind, stream: streamed(['ab', 'cde']).stream }, { precondition: { ifNoneMatch: '*' }, onProgress: progress }));
    expect(f.put).toHaveBeenCalledOnce(); expect(f.create).not.toHaveBeenCalled();
    expect(f.put.mock.calls[0]![0]).toMatchObject({ data: bytes('abcde'), precondition: { ifNoneMatch: '*' } });
    expect(result).toMatchObject({ byteLength: 5, checksum: { algorithm: 'sha256', value: digest('abcde') }, etag: 'put' });
    expect(progress).toHaveBeenCalledExactlyOnceWith(5);
  });

  it.each(['bytes', 'stream'] as const)('uses multipart at the exact threshold for %s', async kind => {
    const f = setup();
    await f.storage.upload(f.request(kind === 'bytes' ? { kind, data: bytes('abcdef') }
      : { kind, stream: streamed(['ab', 'cdef']).stream }));
    expect(f.parts).toEqual([bytes('abcd'), bytes('ef')]);
    expect(f.put).not.toHaveBeenCalled();
  });

  it.each(['bytes', 'stream'] as const)('uploads %s above threshold through ordered direct parts', async kind => {
    const f = setup(); const progress = vi.fn();
    const source = kind === 'bytes' ? { kind, data: bytes('abcdefghij') } : { kind, stream: streamed(['abc', 'defgh', 'ij']).stream };
    const result = await f.storage.upload(f.request(source, { contentType: 'video/mp4', precondition: { ifNoneMatch: '*' }, onProgress: progress }));
    expect(f.put).not.toHaveBeenCalled();
    expect(f.parts).toEqual([bytes('abcd'), bytes('efgh'), bytes('ij')]);
    expect(f.part.mock.calls.map(([x]) => x.partNumber)).toEqual([1, 2, 3]);
    expect(f.create.mock.calls[0]![0]).toMatchObject({ object: { storageId: 'cloud', key: 'result.bin' }, partSize: 4, contentType: 'video/mp4' });
    if (kind === 'stream') expect(f.create.mock.calls[0]![0]).not.toHaveProperty('totalBytes');
    else expect(f.create.mock.calls[0]![0]).toHaveProperty('totalBytes', 10);
    expect(f.complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ uploadId: 'session', precondition: { ifNoneMatch: '*' },
      parts: [{ partNumber: 1, etag: 'part-1' }, { partNumber: 2, etag: 'part-2' }, { partNumber: 3, etag: 'part-3' }] }));
    expect(progress.mock.calls).toEqual([[4], [8], [10]]);
    expect(result).toMatchObject({ byteLength: 10, checksum: { algorithm: 'sha256', value: digest('abcdefghij') }, etag: 'complete' });
    expect(f.abort).not.toHaveBeenCalled();
  });

  it('preserves buffered bytes when the threshold exceeds a part and a single chunk is much larger than both', async () => {
    const f = setup();
    await f.storage.upload(f.request({ kind: 'stream', stream: streamed(['abcde', 'fghijklmnopqrstuvwxyz']).stream }));
    expect(Buffer.concat(f.parts).toString()).toBe('abcdefghijklmnopqrstuvwxyz');
    expect(f.parts.map(x => x.length)).toEqual([4, 4, 4, 4, 4, 4, 2]);
  });

  it('awaits a part and its async progress callback before pulling the next source chunk', async () => {
    const f = setup(); const source = streamed(['abcd', 'efgh']);
    let finishPart: () => void = () => {}; let finishProgress: () => void = () => {};
    f.part.mockImplementationOnce(async input => {
      f.parts.push(input.data.slice()); await new Promise<void>(resolve => { finishPart = resolve; }); return { etag: 'part-1' };
    });
    const progress = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finishProgress = resolve; }));
    const pending = f.storage.upload(f.request({ kind: 'stream', stream: source.stream }, { multipart: 'required', onProgress: progress }));
    await vi.waitFor(() => expect(f.part).toHaveBeenCalledOnce());
    expect(source.pulls()).toBe(1); finishPart();
    await vi.waitFor(() => expect(progress).toHaveBeenCalledOnce());
    expect(source.pulls()).toBe(1); finishProgress();
    await pending;
    expect(f.parts).toEqual([bytes('abcd'), bytes('efgh')]);
  });

  it('honors required multipart for a small body and uses the documented default part size', async () => {
    const f = setup();
    await f.storage.upload(f.request({ kind: 'bytes', data: bytes('a') }, { multipart: 'required', multipartOptions: undefined }));
    expect(f.create.mock.calls[0]![0].partSize).toBe(16 * 1024 * 1024);
    expect(f.parts).toEqual([bytes('a')]); expect(f.put).not.toHaveBeenCalled();
  });

  it.each(['short', 'long'] as const)('rejects a %s declaration mismatch and aborts without completing', async mismatch => {
    const f = setup(); const source = streamed(['abcd', 'efgh']);
    await expect(f.storage.upload(f.request({ kind: 'stream', stream: source.stream, declaredByteLength: mismatch === 'short' ? 9 : 7 })))
      .rejects.toMatchObject({ code: 'constraint_unsatisfied' });
    expect(f.complete).not.toHaveBeenCalled(); expect(f.abort).toHaveBeenCalledOnce(); expect(f.put).not.toHaveBeenCalled();
  });

  it.each(['checksum', 'budget', 'source', 'progress', 'part', 'complete'] as const)('aborts a multipart session after %s failure and preserves the original error', async failure => {
    const f = setup(); const original = new Error('original failure');
    const source = failure === 'source' ? new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes('abcd')); }, pull(c) { c.error(original); } }, { highWaterMark: 0 })
      : streamed(['abcd', 'efgh']).stream;
    if (failure === 'part') f.part.mockRejectedValueOnce(original);
    if (failure === 'complete') f.complete.mockRejectedValueOnce(original);
    f.abort.mockRejectedValueOnce(new Error('cleanup failed'));
    const pending = f.storage.upload(f.request({ kind: 'stream', stream: source }, { multipart: 'required',
      ...(failure === 'checksum' ? { expectedChecksum: { algorithm: 'sha256', value: '0'.repeat(64) } } : {}),
      ...(failure === 'budget' ? { maxInputBytes: 5 } : {}),
      ...(failure === 'progress' ? { onProgress: async () => { throw original; } } : {}),
    }));
    if (failure === 'checksum') await expect(pending).rejects.toMatchObject({ code: 'checksum_mismatch' });
    else if (failure === 'budget') await expect(pending).rejects.toMatchObject({ code: 'input_too_large' });
    else await expect(pending).rejects.toBe(original);
    expect(f.abort).toHaveBeenCalledOnce();
    if (failure !== 'complete') expect(f.complete).not.toHaveBeenCalled();
    expect(source.locked).toBe(false);
  });

  it('cancels a stalled reader immediately and uses an independent live cleanup signal', async () => {
    const f = setup(); const controller = new AbortController(); const cancel = vi.fn();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { if (pulls++ === 0) c.enqueue(bytes('abcd')); }, cancel }, { highWaterMark: 0 });
    const pending = f.storage.upload(f.request({ kind: 'stream', stream }, { multipart: 'required', signal: controller.signal }));
    await vi.waitFor(() => expect(f.part).toHaveBeenCalledOnce()); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(cancel).toHaveBeenCalledOnce(); expect(stream.locked).toBe(false);
    expect(f.abort.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
    expect(f.abort.mock.calls[0]![0].signal?.aborted).toBe(false);
    expect(f.abort.mock.calls[0]![0].signal).not.toBe(controller.signal);
  });

  it('retains a creation receipt arriving after caller cancellation and then aborts it', async () => {
    const f = setup(); const controller = new AbortController();
    let finish: (value: { uploadId: string }) => void = () => {};
    f.create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.storage.upload(f.request({ kind: 'bytes', data: bytes('abcdefgh') }, { signal: controller.signal }));
    await vi.waitFor(() => expect(f.create).toHaveBeenCalledOnce()); controller.abort();
    expect(f.create.mock.calls[0]![0].signal).not.toBe(controller.signal);
    expect(f.create.mock.calls[0]![0].signal?.aborted).toBe(false);
    finish({ uploadId: 'late-session' });
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(f.abort).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ uploadId: 'late-session' }));
    expect(f.part).not.toHaveBeenCalled();
  });

  it('reports cancellation while the final single-put progress callback is still pending', async () => {
    const f = setup(); const controller = new AbortController();
    let finishProgress: () => void = () => {};
    const progress = vi.fn(() => new Promise<void>(resolve => { finishProgress = resolve; }));
    const pending = f.storage.upload(f.request({ kind: 'bytes', data: bytes('abc') }, { signal: controller.signal, onProgress: progress }));
    await vi.waitFor(() => expect(progress).toHaveBeenCalledExactlyOnceWith(3));
    controller.abort(); finishProgress();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(f.put).toHaveBeenCalledOnce(); expect(f.abort).not.toHaveBeenCalled();
  });

  it('reports late multipart cancellation without aborting an already completed session', async () => {
    const f = setup(); const controller = new AbortController();
    let finishComplete: (value: { etag: string }) => void = () => {};
    f.complete.mockImplementationOnce(() => new Promise(resolve => { finishComplete = resolve; }));
    const pending = f.storage.upload(f.request({ kind: 'bytes', data: bytes('abcdefgh') }, { signal: controller.signal }));
    await vi.waitFor(() => expect(f.complete).toHaveBeenCalledOnce());
    controller.abort(); finishComplete({ etag: 'already-committed' });
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(f.abort).not.toHaveBeenCalled(); expect(f.put).not.toHaveBeenCalled();
  });

  it('does not buffer an unbounded stream when multipart is unavailable', async () => {
    const f = setup(false);
    const source = streamed(['abcd', 'efgh', 'never read']);
    await expect(f.storage.upload(f.request({ kind: 'stream', stream: source.stream }))).rejects.toMatchObject({ code: 'capability_unsupported' });
    expect(source.pulls()).toBe(2); expect(source.cancel).toHaveBeenCalledOnce(); expect(f.put).not.toHaveBeenCalled();
  });

  it.each([30, 31])('switches at the default 30 MiB threshold for a declared %i MiB stream', async mib => {
    const f = setup(); const source = streamed([]);
    await expect(f.storage.upload(f.request({ kind: 'stream', stream: source.stream, declaredByteLength: mib * 1024 * 1024 }, { multipartOptions: undefined })))
      .rejects.toMatchObject({ code: 'constraint_unsatisfied' });
    expect(f.create).toHaveBeenCalledOnce();
  });

  it.each([undefined, 0])('preserves empty-stream uploads with declared length %j', async declaredByteLength => {
    const f = setup();
    const result = await f.storage.upload(f.request({ kind: 'stream', stream: streamed([]).stream, ...(declaredByteLength === undefined ? {} : { declaredByteLength }) }));
    expect(result).toMatchObject({ byteLength: 0, checksum: { value: digest('') } });
    expect(f.put.mock.calls[0]![0].data.byteLength).toBe(0);
    expect(f.create).not.toHaveBeenCalled();
  });

  it('does not fall back to put when the direct multipart method is missing', async () => {
    const f = setup(true, { uploadPart: undefined }); const source = streamed(['abcd', 'efgh']);
    await expect(f.storage.upload(f.request({ kind: 'stream', stream: source.stream }))).rejects.toMatchObject({ code: 'capability_unsupported' });
    expect(source.cancel).toHaveBeenCalledOnce(); expect(f.put).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
  });

  it.each([-1, NaN, 1.5])('rejects invalid declared length %j before a read', async declaredByteLength => {
    const f = setup(); const source = streamed(['a']);
    await expect(f.storage.upload(f.request({ kind: 'stream', stream: source.stream, declaredByteLength })))
      .rejects.toMatchObject({ code: 'config_invalid' });
    expect(source.pulls()).toBe(0);
    expect(source.cancel).toHaveBeenCalledOnce(); expect(source.stream.locked).toBe(false);
  });

  it.each([-1, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid maxInputBytes %j before a read', async maxInputBytes => {
    const f = setup(); const source = streamed(['a']);
    await expect(f.storage.upload(f.request({ kind: 'stream', stream: source.stream }, { maxInputBytes })))
      .rejects.toMatchObject({ code: 'config_invalid' });
    expect(source.pulls()).toBe(0);
    expect(source.cancel).toHaveBeenCalledOnce(); expect(source.stream.locked).toBe(false);
  });

  it('rejects unsupported expected checksums before reading or creating a session', async () => {
    const f = setup(); const source = streamed(['a']);
    await expect(f.storage.upload(f.request({ kind: 'stream', stream: source.stream }, { expectedChecksum: { algorithm: 'crc64-ecma', value: '123' } })))
      .rejects.toMatchObject({ code: 'capability_unsupported' });
    expect(source.pulls()).toBe(0); expect(f.create).not.toHaveBeenCalled();
    expect(source.cancel).toHaveBeenCalledOnce(); expect(source.stream.locked).toBe(false);
  });

  it('rejects pre-aborted upload without touching the source or driver', async () => {
    const f = setup(); const source = streamed(['a']);
    await expect(f.storage.upload(f.request({ kind: 'stream', stream: source.stream }, { signal: AbortSignal.abort() })))
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(source.pulls()).toBe(0); expect(f.create).not.toHaveBeenCalled(); expect(f.put).not.toHaveBeenCalled();
    expect(source.cancel).toHaveBeenCalledOnce(); expect(source.stream.locked).toBe(false);
  });

  it('cleans up a session whose direct part response has no etag', async () => {
    const f = setup(); f.part.mockResolvedValueOnce({ etag: ' ' });
    await expect(f.storage.upload(f.request({ kind: 'bytes', data: bytes('abcdefgh') }))).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.complete).not.toHaveBeenCalled(); expect(f.abort).toHaveBeenCalledOnce();
  });

  it.each(['failed', 'missing'] as const)('does not abort an unaccepted multipart session when creation is %s', async failure => {
    const f = setup(); const source = streamed(['abcdefgh']);
    if (failure === 'failed') f.create.mockRejectedValueOnce(new Error('Creation failed'));
    else f.create.mockResolvedValueOnce({ uploadId: '' });
    await expect(f.storage.upload(f.request({ kind: 'stream', stream: source.stream }))).rejects.toThrow(failure === 'failed' ? 'Creation failed' : 'id is missing');
    expect(source.cancel).toHaveBeenCalledOnce(); expect(f.abort).not.toHaveBeenCalled(); expect(f.part).not.toHaveBeenCalled();
  });

  it.each([
    { thresholdBytes: 0, partSizeBytes: 4 }, { thresholdBytes: Number.MAX_SAFE_INTEGER + 1, partSizeBytes: 4 },
    { thresholdBytes: 6, partSizeBytes: 1 }, { thresholdBytes: 6, partSizeBytes: 65 * 1024 * 1024 },
    { thresholdBytes: 6, partSizeBytes: 2.5 },
  ])('rejects invalid multipart bounds without consuming the source: %j', async multipartOptions => {
    const f = setup(); const source = streamed(['a']);
    await expect(f.storage.upload(f.request({ kind: 'stream', stream: source.stream }, { multipartOptions }))).rejects.toMatchObject({ code: 'config_invalid' });
    expect(source.pulls()).toBe(0); expect(f.create).not.toHaveBeenCalled(); expect(f.put).not.toHaveBeenCalled();
    expect(source.cancel).toHaveBeenCalledOnce(); expect(source.stream.locked).toBe(false);
  });

  it.each([
    { storageId: 'unknown' }, { key: '' }, { maxInputBytes: 2 },
  ])('owns and closes the supplied stream on entry validation failure: %j', async overrides => {
    const f = setup(); const source = streamed(['a']);
    await expect(f.storage.upload(f.request({ kind: 'stream', stream: source.stream, declaredByteLength: 3 }, overrides))).rejects.toBeInstanceOf(Error);
    expect(source.pulls()).toBe(0); expect(source.cancel).toHaveBeenCalledOnce(); expect(source.stream.locked).toBe(false);
  });

  it('streams a caller-owned file through parts and leaves it unchanged', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'object-storage-stream-'));
    const path = join(directory, 'input.bin');
    try {
      await writeFile(path, 'abcdefghij'); const f = setup();
      const result = await f.storage.upload(f.request({ kind: 'file', path }));
      expect(f.parts).toEqual([bytes('abcd'), bytes('efgh'), bytes('ij')]);
      expect(result.checksum?.value).toBe(digest('abcdefghij'));
      expect(await readFile(path, 'utf8')).toBe('abcdefghij');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('does not prefetch the entire file through the Node-to-Web bridge while a part is blocked', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'object-storage-backpressure-'));
    const path = join(directory, 'input.bin');
    let finishPart: () => void = () => {};
    let produced = 0;
    const input = new Readable({ highWaterMark: 32, read() {
      if (produced === 16) this.push(null);
      else { produced += 1; this.push(Buffer.alloc(32)); }
    } });
    try {
      await writeFile(path, Buffer.alloc(512));
      vi.mocked(createReadStream).mockReturnValueOnce(input as ReadStream);
      const f = setup();
      f.part.mockImplementationOnce(async part => {
        f.parts.push(part.data.slice()); await new Promise<void>(resolve => { finishPart = resolve; }); return { etag: 'part-1' };
      });
      const pending = f.storage.upload(f.request({ kind: 'file', path }, { multipartOptions: { thresholdBytes: 64, partSizeBytes: 32 } }));
      await vi.waitFor(() => expect(f.part).toHaveBeenCalledOnce());
      await new Promise(resolve => setImmediate(resolve));
      const whileBlocked = produced;
      finishPart(); await pending;
      expect(whileBlocked).toBeLessThanOrEqual(3);
      expect(Buffer.concat(f.parts)).toEqual(Buffer.alloc(512));
    } finally { input.destroy(); await rm(directory, { recursive: true, force: true }); }
  });
});
