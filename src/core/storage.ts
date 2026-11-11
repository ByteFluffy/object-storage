import type {
  Checksum,
  FinalizeRequest,
  ObjectRef,
  ObjectStat,
  StorageDriver,
  UploadRequest,
  UploadResult,
} from './contracts.js';
import { StorageError } from './errors.js';
import { sha256Checksum } from '../io/hash.js';
import { readSource } from '../io/sources.js';

export class Storage {
  constructor(private readonly drivers: ReadonlyMap<string, StorageDriver>) {}

  async upload(request: UploadRequest): Promise<UploadResult> {
    assertKey(request.key);
    const driver = this.requireDriver(request.storageId);
    throwIfAborted(request.signal);
    assertPutSupported(driver, request);
    const body = await readSource(request.source, {
      ...(request.maxInputBytes === undefined ? {} : { maxInputBytes: request.maxInputBytes }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const checksum = sha256Checksum(body.data);
    assertExpectedChecksum(request.expectedChecksum, checksum);
    const written = await driver.put({
      object: { storageId: request.storageId, key: request.key },
      data: body.data,
      checksum,
      ...(request.contentType === undefined ? {} : { contentType: request.contentType }),
      ...(request.precondition === undefined ? {} : { precondition: request.precondition }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    return resultOf(request.storageId, request.key, body.byteLength, checksum, written.etag, false);
  }

  async finalize(request: FinalizeRequest): Promise<UploadResult> {
    assertKey(request.tempKey);
    assertKey(request.finalKey);
    if (request.tempKey === request.finalKey) {
      throw new StorageError('config_invalid', 'temp key and final key must differ');
    }
    const driver = this.requireDriver(request.storageId);
    throwIfAborted(request.signal);
    if (!driver.capabilities.copy || !driver.capabilities.conditionalWrite.ifNoneMatch) {
      throw new StorageError('capability_unsupported', 'finalize requires copy and if-none-match');
    }
    if (request.expectedChecksum.algorithm !== 'sha256') {
      throw new StorageError('capability_unsupported', 'only sha256 checksums are verified');
    }

    const temp = await driver.stat({ storageId: request.storageId, key: request.tempKey });
    if (!temp) throw new StorageError('not_found', 'temp object not found');
    if (temp.checksum?.algorithm !== 'sha256' || temp.checksum.value !== request.expectedChecksum.value) {
      throw new StorageError('checksum_mismatch', 'temp object checksum does not match');
    }

    const finalRef = { storageId: request.storageId, key: request.finalKey };
    const existing = await driver.stat(finalRef);
    if (existing) return reuseOrReject(request.storageId, finalRef.key, existing, request.expectedChecksum.value);

    try {
      await driver.copy({
        from: { storageId: request.storageId, key: request.tempKey },
        to: finalRef,
        ifNoneMatch: '*',
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error) {
      if (error instanceof StorageError && error.code === 'conflict') {
        const raced = await driver.stat(finalRef);
        if (raced) return reuseOrReject(request.storageId, finalRef.key, raced, request.expectedChecksum.value);
      }
      throw error;
    }

    const sealed = await driver.stat(finalRef);
    if (!sealed?.checksum) throw new StorageError('checksum_mismatch', 'sealed object has no checksum');
    if (sealed.checksum.value !== request.expectedChecksum.value) {
      throw new StorageError('checksum_mismatch', 'sealed object checksum does not match');
    }
    return resultOf(request.storageId, finalRef.key, sealed.byteLength, sealed.checksum, sealed.etag, false);
  }

  async stat(ref: ObjectRef): Promise<ObjectStat | null> {
    assertKey(ref.key);
    return this.requireDriver(ref.storageId).stat(ref);
  }

  async read(ref: ObjectRef): Promise<{ data: Uint8Array; byteLength: number; checksum: Checksum | null }> {
    assertKey(ref.key);
    const loaded = await this.requireDriver(ref.storageId).read(ref);
    return { data: loaded.data, byteLength: loaded.data.byteLength, checksum: loaded.checksum };
  }

  private requireDriver(storageId: string): StorageDriver {
    const driver = this.drivers.get(storageId);
    if (!driver) throw new StorageError('config_missing', `unknown storageId: ${storageId}`);
    return driver;
  }
}

export function createStorage(input: Readonly<{ drivers: readonly StorageDriver[] }>): Storage {
  const drivers = new Map<string, StorageDriver>();
  for (const driver of input.drivers) {
    if (driver.storageId.length === 0 || drivers.has(driver.storageId)) {
      throw new StorageError('config_invalid', 'storageId must be unique and non-empty');
    }
    drivers.set(driver.storageId, driver);
  }
  return new Storage(drivers);
}

function assertPutSupported(driver: StorageDriver, request: UploadRequest): void {
  if (request.multipart === 'required' && driver.capabilities.multipart === null) {
    throw new StorageError('capability_unsupported', 'multipart is not available');
  }
  if (!driver.capabilities.put) {
    throw new StorageError('capability_unsupported', 'put is not available');
  }
  if (request.precondition?.ifNoneMatch === '*' && !driver.capabilities.conditionalWrite.ifNoneMatch) {
    throw new StorageError('capability_unsupported', 'if-none-match is not available');
  }
}

function assertExpectedChecksum(expected: Checksum | undefined, actual: Checksum): void {
  if (!expected) return;
  if (expected.algorithm !== 'sha256') {
    throw new StorageError('capability_unsupported', 'only sha256 checksums are verified');
  }
  if (expected.value !== actual.value) {
    throw new StorageError('checksum_mismatch', 'bytes do not match the expected checksum');
  }
}

function reuseOrReject(
  storageId: string,
  key: string,
  existing: ObjectStat,
  expected: string,
): UploadResult {
  if (existing.checksum?.algorithm === 'sha256' && existing.checksum.value === expected) {
    return resultOf(storageId, key, existing.byteLength, existing.checksum, existing.etag, true);
  }
  throw new StorageError('conflict', 'final object has different content');
}

function resultOf(
  storageId: string,
  key: string,
  byteLength: number,
  checksum: Checksum,
  etag: string | null,
  reused: boolean,
): UploadResult {
  return {
    object: { storageId, key },
    byteLength,
    checksum,
    etag,
    reused,
    delivery: { status: 'not_requested' },
  };
}

function assertKey(key: string): void {
  if (key.length === 0) throw new StorageError('empty_key', 'object key is empty');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new StorageError('cancelled', 'operation cancelled');
}
