import type {
  Checksum,
  DriverCopy,
  DriverPut,
  ObjectRef,
  ObjectStat,
  StorageDriver,
} from '../core/contracts.js';
import { StorageError } from '../core/errors.js';
import { sha256Checksum } from '../io/hash.js';

type StoredObject = Readonly<{
  data: Uint8Array;
  contentType: string | undefined;
  checksum: Checksum;
  etag: string;
}>;

export function createMemoryDriver(options: Readonly<{ storageId: string }>): StorageDriver {
  const objects = new Map<string, StoredObject>();

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
    async stat(ref: ObjectRef): Promise<ObjectStat | null> {
      const stored = objects.get(ref.key);
      if (!stored) return null;
      return toStat(stored);
    },
    async read(ref: ObjectRef) {
      const stored = requireObject(objects, ref.key);
      return { data: stored.data.slice(), checksum: stored.checksum };
    },
    async copy(input: DriverCopy) {
      const source = requireObject(objects, input.from.key);
      rejectIfPresent(objects, input.to.key, input.ifNoneMatch);
      objects.set(input.to.key, {
        ...source,
        data: source.data.slice(),
      });
    },
    async delete(ref: ObjectRef) {
      objects.delete(ref.key);
    },
  };
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
