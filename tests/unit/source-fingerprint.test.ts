import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprintSource } from '../../src/index.js';

const abc = new TextEncoder().encode('abc');
const abcChecksum = { algorithm: 'sha256', value: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' };
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'source-fingerprint-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function streamed(chunks: Uint8Array[]) {
  let pulls = 0;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[pulls++];
      if (chunk === undefined) controller.close(); else controller.enqueue(chunk);
    },
    cancel,
  }, { highWaterMark: 0 });
  return { stream, cancel, pulls: () => pulls };
}

describe('source content fingerprint', () => {
  it('reports the SHA-256 and actual byte length through the public entry', async () => {
    await expect(fingerprintSource({ kind: 'bytes', data: abc })).resolves.toEqual({ byteLength: 3, checksum: abcChecksum });
  });

  it('hashes only the bytes in a typed-array view', async () => {
    const larger = new TextEncoder().encode('xabcx');
    await expect(fingerprintSource({ kind: 'bytes', data: larger.subarray(1, 4) }))
      .resolves.toEqual({ byteLength: 3, checksum: abcChecksum });
  });

  it('reads file content without modifying or deleting its source', async () => {
    const path = join(directory, 'original.bin');
    await writeFile(path, abc);
    await expect(fingerprintSource({ kind: 'file', path })).resolves.toEqual({ byteLength: 3, checksum: abcChecksum });
    expect(await readFile(path)).toEqual(Buffer.from(abc));
  });

  it('gives identical files the same fingerprint despite different paths and modification times', async () => {
    const left = join(directory, 'first.png');
    const right = join(directory, 'renamed.png');
    await writeFile(left, abc);
    await writeFile(right, abc);
    await utimes(right, new Date(0), new Date(0));
    expect(await fingerprintSource({ kind: 'file', path: left })).toEqual(await fingerprintSource({ kind: 'file', path: right }));
  });

  it('distinguishes different content with the same length', async () => {
    const left = await fingerprintSource({ kind: 'bytes', data: abc });
    const right = await fingerprintSource({ kind: 'bytes', data: new TextEncoder().encode('abd') });
    expect(left.byteLength).toBe(right.byteLength);
    expect(left.checksum).not.toEqual(right.checksum);
  });

  it('consumes a stream once regardless of chunk boundaries and releases its lock', async () => {
    const source = streamed([abc.subarray(0, 1), new Uint8Array(), abc.subarray(1)]);
    await expect(fingerprintSource({ kind: 'stream', stream: source.stream, declaredByteLength: 3 }))
      .resolves.toEqual({ byteLength: 3, checksum: abcChecksum });
    expect(source.pulls()).toBe(4);
    expect(source.cancel).not.toHaveBeenCalled();
    expect(source.stream.locked).toBe(false);
  });

  it('fingerprints an incrementally produced source without requiring a declared length', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(7);
    const expected = createHash('sha256');
    for (let i = 0; i < 128; i++) expected.update(chunk);
    let remaining = 128;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (remaining-- > 0) controller.enqueue(chunk); else controller.close();
    } }, { highWaterMark: 0 });
    expect(await fingerprintSource({ kind: 'stream', stream })).toEqual({
      byteLength: 8 * 1024 * 1024, checksum: { algorithm: 'sha256', value: expected.digest('hex') },
    });
    expect(stream.locked).toBe(false);
  });

  it('accepts empty bytes, files and streams as the same valid content', async () => {
    const path = join(directory, 'empty');
    await writeFile(path, new Uint8Array());
    const expected = { byteLength: 0, checksum: { algorithm: 'sha256', value: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' } };
    await expect(fingerprintSource({ kind: 'bytes', data: new Uint8Array() })).resolves.toEqual(expected);
    await expect(fingerprintSource({ kind: 'file', path })).resolves.toEqual(expected);
    await expect(fingerprintSource({ kind: 'stream', stream: streamed([]).stream, declaredByteLength: 0 })).resolves.toEqual(expected);
  });

  it('accepts the exact read budget and rejects a stream exceeding it', async () => {
    await expect(fingerprintSource({ kind: 'bytes', data: abc }, { maxBytes: 3 })).resolves.toEqual({ byteLength: 3, checksum: abcChecksum });
    const source = streamed([abc]);
    await expect(fingerprintSource({ kind: 'stream', stream: source.stream }, { maxBytes: 2 }))
      .rejects.toMatchObject({ code: 'input_too_large' });
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(source.stream.locked).toBe(false);
  });

  it.each([2, 4])('rejects a stream whose declared length %i differs from the actual bytes', async declaredByteLength => {
    const source = streamed([abc]);
    await expect(fingerprintSource({ kind: 'stream', stream: source.stream, declaredByteLength }))
      .rejects.toMatchObject({ code: 'constraint_unsatisfied' });
    expect(source.stream.locked).toBe(false);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid read budget %s before pulling', async maxBytes => {
    const source = streamed([abc]);
    await expect(fingerprintSource({ kind: 'stream', stream: source.stream }, { maxBytes }))
      .rejects.toMatchObject({ code: 'config_invalid' });
    expect(source.pulls()).toBe(0);
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(source.stream.locked).toBe(false);
  });

  it('cancels a pre-aborted input before pulling and releases it', async () => {
    const source = streamed([abc]);
    await expect(fingerprintSource({ kind: 'stream', stream: source.stream }, { signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(source.pulls()).toBe(0);
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(source.stream.locked).toBe(false);
  });

  it('actively cancels a stalled input and releases its reader', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const pending = fingerprintSource({ kind: 'stream', stream }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it('preserves a source read failure and releases its lock', async () => {
    const failure = new Error('source failed');
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(failure); } }, { highWaterMark: 0 });
    await expect(fingerprintSource({ kind: 'stream', stream })).rejects.toBe(failure);
    expect(stream.locked).toBe(false);
  });

  it('propagates a missing local file without manufacturing a fingerprint', async () => {
    await expect(fingerprintSource({ kind: 'file', path: join(directory, 'missing') })).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
