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

    const tempRef = { storageId: request.storageId, key: request.tempKey };
    const temp = await driver.stat(tempRef);
    if (!temp) throw new StorageError('not_found', 'temp object not found');
    await sha256Of(driver, tempRef, temp, request.expectedChecksum.value, request.maxReadBytes);

    const finalRef = { storageId: request.storageId, key: request.finalKey };
    const existing = await driver.stat(finalRef);
    if (existing) {
      return reuseOrReject(driver, finalRef, existing, request.expectedChecksum.value, request.maxReadBytes);
    }

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
        if (raced) {
          return reuseOrReject(driver, finalRef, raced, request.expectedChecksum.value, request.maxReadBytes);
        }
      }
      throw error;
    }

    const sealed = await driver.stat(finalRef);
    if (!sealed) throw new StorageError('not_found', 'sealed object not found');
    const sealedChecksum = await sha256Of(driver, finalRef, sealed, request.expectedChecksum.value, request.maxReadBytes);
    return resultOf(request.storageId, finalRef.key, sealed.byteLength, sealedChecksum, sealed.etag, false);
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

async function reuseOrReject(
  driver: StorageDriver,
  ref: ObjectRef,
  existing: ObjectStat,
  expected: string,
  maxReadBytes: number | undefined,
): Promise<UploadResult> {
  const checksum = await sha256Of(driver, ref, existing, expected, maxReadBytes);
  return resultOf(ref.storageId, ref.key, existing.byteLength, checksum, existing.etag, true);
}

async function sha256Of(
  driver: StorageDriver,
  ref: ObjectRef,
  stat: ObjectStat,
  expected: string,
  maxReadBytes: number | undefined,
): Promise<Checksum> {
  if (stat.checksum?.algorithm === 'sha256') {
    if (stat.checksum.value !== expected) {
      throw new StorageError('checksum_mismatch', 'object checksum does not match');
    }
    return stat.checksum;
  }
  if (maxReadBytes === undefined || stat.byteLength > maxReadBytes) {
    throw new StorageError('checksum_mismatch', 'object has no sha256 checksum');
  }
  const loaded = await driver.read(ref);
  const actual = sha256Checksum(loaded.data);
  if (actual.value !== expected) throw new StorageError('checksum_mismatch', 'object checksum does not match');
  return actual;
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
