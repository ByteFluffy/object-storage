import type {
  Checksum,
  DriverCopy,
  DriverPut,
  ObjectRef,
  ObjectStat,
  ObjectOperationOptions,
  ReadOptions,
  StorageDriver,
} from '../core/contracts.js';
import { StorageError } from '../core/errors.js';
import { sha256Checksum } from '../io/hash.js';
import { openBoundedRead, readBytes } from '../io/read.js';

type StoredObject = Readonly<{
  data: Uint8Array;
  contentType: string | undefined;
  checksum: Checksum;
  etag: string;
}>;

export function createMemoryDriver(options: Readonly<{ storageId: string }>): StorageDriver {
  const objects = new Map<string, StoredObject>();
  const openRead = async (ref: ObjectRef, options?: ReadOptions) => {
    throwIfAborted(options);
    const stored = requireObject(objects, ref.key);
    return openBoundedRead({ body: new ReadableStream<Uint8Array>({ pull(controller) {
      controller.enqueue(stored.data.slice()); controller.close();
    } }, { highWaterMark: 0 }), byteLength: stored.data.byteLength,
    ...(stored.contentType === undefined ? {} : { contentType: stored.contentType }) }, options);
  };

  return {
    storageId: options.storageId,
    capabilities: {
      put: true,
      copy: true,
      conditionalWrite: { ifNoneMatch: true },
      checksums: ['sha256'],
      presignMethods: [],
      multipart: null,
    },
    async put(input: DriverPut) {
      rejectIfPresent(objects, input.object.key, input.precondition?.ifNoneMatch);
      const checksum = sha256Checksum(input.data);
      const stored: StoredObject = {
        data: input.data.slice(),
        contentType: input.contentType,
        checksum,
        etag: `mem:${checksum.value}:${input.data.byteLength}`,
      };
      objects.set(input.object.key, stored);
      return { etag: stored.etag, checksum };
    },
    async stat(ref: ObjectRef, options?: ObjectOperationOptions): Promise<ObjectStat | null> {
      throwIfAborted(options);
      const stored = objects.get(ref.key);
      if (!stored) return null;
      return toStat(stored);
    },
    openRead,
    async read(ref: ObjectRef, options?: ReadOptions) {
      return readBytes(await openRead(ref, options));
    },
    async copy(input: DriverCopy) {
      const source = requireObject(objects, input.from.key);
      rejectIfPresent(objects, input.to.key, input.ifNoneMatch);
      objects.set(input.to.key, {
        ...source,
        data: source.data.slice(),
      });
    },
    async delete(ref: ObjectRef, options?: ObjectOperationOptions) {
      throwIfAborted(options);
      objects.delete(ref.key);
    },
  };
}

function throwIfAborted(options: ObjectOperationOptions | undefined): void {
  if (options?.signal?.aborted) throw new StorageError('cancelled', 'operation cancelled');
}

function toStat(stored: StoredObject): ObjectStat {
  return {
    byteLength: stored.data.byteLength,
    checksum: stored.checksum,
    etag: stored.etag,
    ...(stored.contentType === undefined ? {} : { contentType: stored.contentType }),
  };
}

function requireObject(objects: ReadonlyMap<string, StoredObject>, key: string): StoredObject {
  const stored = objects.get(key);
  if (!stored) throw new StorageError('not_found', 'object not found');
  return stored;
}

function rejectIfPresent(
  objects: ReadonlyMap<string, StoredObject>,
  key: string,
  ifNoneMatch: '*' | undefined,
): void {
  if (ifNoneMatch === '*' && objects.has(key)) {
    throw new StorageError('conflict', 'object already exists');
  }
}
