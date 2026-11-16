import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { Checksum, Source, StorageDriver, UploadRequest } from './contracts.js';
import { StorageError } from './errors.js';

const DEFAULT_THRESHOLD = 30 * 1024 * 1024;
const DEFAULT_PART_SIZE = 16 * 1024 * 1024;
const SESSION_TIMEOUT_MS = 10_000;

export async function uploadToDriver(request: UploadRequest, resolveDriver: () => StorageDriver): Promise<{
  byteLength: number; checksum: Checksum; etag: string | null;
}> {
  let reader = request.source.kind === 'stream' ? request.source.stream.getReader() : undefined;
  let resolvedDriver: StorageDriver | undefined;
  let buffer = new Uint8Array(0);
  let buffered = 0;
  let byteLength = 0;
  let uploadedBytes = 0;
  let uploadId: string | undefined;
  let cancelledReader = false;
  const object = { storageId: request.storageId, key: request.key };
  const parts: { partNumber: number; etag: string }[] = [];
  const hash = createHash('sha256');
  const cancelReader = () => {
    if (cancelledReader || !reader) return;
    cancelledReader = true;
    void reader.cancel().catch(() => {});
  };
  request.signal?.addEventListener('abort', cancelReader, { once: true });

  try {
    const driver = resolveDriver();
    resolvedDriver = driver;
    const { thresholdBytes, partSizeBytes } = request.multipartOptions ?? {
      thresholdBytes: DEFAULT_THRESHOLD, partSizeBytes: DEFAULT_PART_SIZE,
    };
    assertPositiveInteger(thresholdBytes, 'thresholdBytes');
    assertPositiveInteger(partSizeBytes, 'partSizeBytes');
    if (request.maxInputBytes !== undefined) assertByteLength(request.maxInputBytes, 'maxInputBytes');
    if (request.expectedChecksum && request.expectedChecksum.algorithm !== 'sha256') {
      throw new StorageError('capability_unsupported', 'only sha256 checksums are verified');
    }
    throwIfAborted(request.signal);
    if (request.precondition && !driver.capabilities.conditionalWrite.ifNoneMatch) {
      throw new StorageError('capability_unsupported', 'if-none-match is not available');
    }
    const limits = driver.capabilities.multipart;
    if (limits) {
      assertPositiveInteger(limits.minPartBytes, 'minPartBytes');
      assertPositiveInteger(limits.maxPartBytes, 'maxPartBytes');
      if (partSizeBytes < limits.minPartBytes || partSizeBytes > limits.maxPartBytes) {
        throw new StorageError('config_invalid', 'partSizeBytes is outside the driver multipart limits');
      }
    }
    const declaredBytes = request.source.kind === 'file' ? (await stat(request.source.path)).size
      : request.source.kind === 'bytes' ? request.source.data.byteLength : request.source.declaredByteLength;
    if (declaredBytes !== undefined) {
      assertByteLength(declaredBytes, 'declaredByteLength');
      assertBudget(declaredBytes, request.maxInputBytes);
    }
    const startsMultipart = request.multipart === 'required' || (declaredBytes !== undefined && declaredBytes >= thresholdBytes);
    if (startsMultipart) assertMultipart(driver);
    else if (!driver.capabilities.put) throw new StorageError('capability_unsupported', 'put is not available');
    throwIfAborted(request.signal);

    reader ??= sourceStream(request.source).getReader();
    const capacity = startsMultipart ? partSizeBytes : declaredBytes ?? Math.max(thresholdBytes, partSizeBytes);
    const beginMultipart = async () => {
      assertMultipart(driver);
      const session = await driver.createMultipart!({ object, partSize: partSizeBytes,
        ...(declaredBytes === undefined ? {} : { totalBytes: declaredBytes }),
        ...(request.contentType === undefined ? {} : { contentType: request.contentType }),
        // Creation must return its receipt before caller cancellation can trigger cleanup.
        signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
      });
      uploadId = session.uploadId;
      if (!uploadId) throw new StorageError('unavailable', 'multipart upload id is missing');
      throwIfAborted(request.signal);
    };
    const sendPart = async (size: number) => {
      throwIfAborted(request.signal);
      const partNumber = parts.length + 1;
      const written = await driver.uploadPart!({ object, uploadId: uploadId!, partNumber,
        data: buffer.subarray(0, size), ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (!written.etag.trim()) throw new StorageError('unavailable', 'multipart part etag is missing');
      parts.push({ partNumber, etag: written.etag });
      buffered -= size;
      buffer.copyWithin(0, size, size + buffered);
      uploadedBytes += size;
      await request.onProgress?.(uploadedBytes);
      throwIfAborted(request.signal);
    };

    if (startsMultipart) await beginMultipart();
    while (true) {
      throwIfAborted(request.signal);
      const next = await reader.read();
      throwIfAborted(request.signal);
      if (next.done) break;
      const chunk = next.value;
      byteLength += chunk.byteLength;
      assertBudget(byteLength, request.maxInputBytes);
      if (declaredBytes !== undefined && byteLength > declaredBytes) throwLengthMismatch();
      hash.update(chunk);
      if (!uploadId && byteLength >= thresholdBytes) await beginMultipart();
      if (!buffer.byteLength && chunk.byteLength) buffer = new Uint8Array(capacity);
      let offset = 0;
      while (offset < chunk.byteLength) {
        while (uploadId && buffered >= partSizeBytes) await sendPart(partSizeBytes);
        const size = Math.min((uploadId ? partSizeBytes : capacity) - buffered, chunk.byteLength - offset);
        buffer.set(chunk.subarray(offset, offset + size), buffered);
        buffered += size;
        offset += size;
        if (uploadId && buffered >= partSizeBytes) await sendPart(partSizeBytes);
      }
    }
    if (declaredBytes !== undefined && byteLength !== declaredBytes) throwLengthMismatch();
    const checksum: Checksum = { algorithm: 'sha256', value: hash.digest('hex') };
    if (request.expectedChecksum && request.expectedChecksum.value !== checksum.value) {
      throw new StorageError('checksum_mismatch', 'bytes do not match the expected checksum');
    }
    if (uploadId) {
      if (buffered || parts.length === 0) await sendPart(buffered);
      const written = await driver.completeMultipart!({ object, uploadId, parts,
        ...(request.precondition === undefined ? {} : { precondition: request.precondition }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      uploadId = undefined;
      throwIfAborted(request.signal);
      return { byteLength, checksum, etag: written.etag };
    }
    const written = await driver.put({ object, data: buffer.subarray(0, buffered), checksum,
      ...(request.contentType === undefined ? {} : { contentType: request.contentType }),
      ...(request.precondition === undefined ? {} : { precondition: request.precondition }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    await request.onProgress?.(byteLength);
    throwIfAborted(request.signal);
    return { byteLength, checksum, etag: written.etag };
  } catch (error) {
    cancelReader();
    if (uploadId) {
      try {
        await resolvedDriver!.abortMultipart!({ object, uploadId, signal: AbortSignal.timeout(SESSION_TIMEOUT_MS) });
      } catch { /* Cleanup cannot replace the source or provider error. */ }
    }
    throw error;
  } finally {
    request.signal?.removeEventListener('abort', cancelReader);
    reader?.releaseLock();
  }
}

function sourceStream(source: Source): ReadableStream<Uint8Array> {
  if (source.kind === 'stream') return source.stream;
  if (source.kind === 'file') return Readable.toWeb(createReadStream(source.path), { strategy: { highWaterMark: 0 } }) as ReadableStream<Uint8Array>;
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(source.data); controller.close(); } });
}

function assertMultipart(driver: StorageDriver): void {
  if (!driver.capabilities.multipart || !driver.createMultipart || !driver.uploadPart || !driver.completeMultipart || !driver.abortMultipart) {
    throw new StorageError('capability_unsupported', 'direct multipart upload is not available');
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new StorageError('config_invalid', `${name} must be a positive safe integer`);
}

function assertByteLength(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new StorageError('config_invalid', `${name} must be a non-negative safe integer`);
}

function assertBudget(value: number, maximum: number | undefined): void {
  if (!Number.isSafeInteger(value) || (maximum !== undefined && value > maximum)) throw new StorageError('input_too_large', 'input exceeds maxInputBytes');
}

function throwLengthMismatch(): never {
  throw new StorageError('constraint_unsatisfied', 'source byte length does not match declaredByteLength');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new StorageError('cancelled', 'operation cancelled');
}
