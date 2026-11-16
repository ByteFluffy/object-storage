import { createHash } from 'node:crypto';
import type { Checksum, OpenReadResult, ReadOptions } from '../core/contracts.js';
import { StorageError } from '../core/errors.js';

export function openBoundedRead(result: OpenReadResult, options: ReadOptions = {}): OpenReadResult {
  const reader = result.body.getReader();
  let closed = false;
  let byteLength = 0;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const finish = (cancel: boolean, reason?: unknown) => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener('abort', abort);
    if (cancel) void reader.cancel(reason).catch(() => {});
    reader.releaseLock();
  };
  const fail = (error: unknown) => {
    if (closed) return;
    finish(true, error);
    output.error(error);
  };
  const abort = () => fail(new StorageError('cancelled', 'operation cancelled'));
  try {
    if (options.maxBytes !== undefined) assertByteLength(options.maxBytes, 'maxBytes');
    if (result.byteLength !== undefined) assertByteLength(result.byteLength, 'byteLength');
    if (options.signal?.aborted) throw new StorageError('cancelled', 'operation cancelled');
    if (result.byteLength !== undefined && options.maxBytes !== undefined && result.byteLength > options.maxBytes) {
      throw new StorageError('input_too_large', 'read exceeds maxBytes');
    }
  } catch (error) {
    finish(true, error);
    throw error;
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      options.signal?.addEventListener('abort', abort, { once: true });
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (closed) return;
        if (next.done) {
          if (result.byteLength !== undefined && byteLength !== result.byteLength) throwLengthMismatch();
          finish(false);
          controller.close();
          return;
        }
        byteLength += next.value.byteLength;
        if (!Number.isSafeInteger(byteLength) || (options.maxBytes !== undefined && byteLength > options.maxBytes)) {
          throw new StorageError('input_too_large', 'read exceeds maxBytes');
        }
        if (result.byteLength !== undefined && byteLength > result.byteLength) throwLengthMismatch();
        controller.enqueue(next.value);
      } catch (error) { fail(error); }
    },
    cancel(reason) { finish(true, reason); },
  }, { highWaterMark: 0 });
  return { ...result, body };
}

/** Consume a managed read; raw transports must first pass through openBoundedRead. */
export async function readBytes(result: OpenReadResult): Promise<{
  data: Uint8Array; byteLength: number; checksum: Checksum; contentType?: string;
}> {
  const reader = result.body.getReader();
  const chunks: Uint8Array[] = [];
  const hash = createHash('sha256');
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(new Uint8Array(next.value));
      hash.update(next.value);
      byteLength += next.value.byteLength;
    }
    const data = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return { data, byteLength, checksum: { algorithm: 'sha256', value: hash.digest('hex') },
      ...(result.contentType === undefined ? {} : { contentType: result.contentType }),
    };
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

function assertByteLength(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new StorageError('config_invalid', `${name} must be a non-negative safe integer`);
}

function throwLengthMismatch(): never {
  throw new StorageError('constraint_unsatisfied', 'read byte length does not match the declared byteLength');
}
