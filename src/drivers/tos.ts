import { isCancel, TosClient } from '@volcengine/tos-sdk';
import type {
  AbortMultipartInput,
  Checksum,
  CompleteMultipartInput,
  CreateMultipartInput,
  DirectUploadPlan,
  DriverCopy,
  DriverPut,
  ObjectRef,
  ObjectStat,
  PresignPartInput,
  PresignPutInput,
  StorageDriver,
} from '../core/contracts.js';
import { StorageError, type StorageErrorCode } from '../core/errors.js';
import { sha256Checksum } from '../io/hash.js';

const CRC64_HEADER = 'x-tos-hash-crc64ecma';
// uploadFile in @volcengine/tos-sdk@2.9.1 uses 5 MiB as the minimum part except the last one.
const MIN_PART_BYTES = 5 * 1024 * 1024;
const MAX_PART_BYTES = 5 * 1024 * 1024 * 1024;

type TosHeaders = { [key: string]: string | undefined };

export type TosResult<T> = {
  data: T;
  headers?: TosHeaders;
  statusCode?: number;
  requestId?: string;
};

export type TosObjectClient = {
  putObject(input: {
    bucket?: string;
    key: string;
    body?: Buffer;
    contentType?: string;
    forbidOverwrite?: boolean;
  }): Promise<TosResult<Record<string, string | undefined>>>;
  headObject(input: { bucket?: string; key: string; versionId?: string }): Promise<TosResult<TosHeaders>>;
  getObject(input: { bucket?: string; key: string; versionId?: string }): Promise<TosResult<Buffer>>;
  deleteObject(input: { bucket?: string; key: string; versionId?: string }): Promise<TosResult<unknown>>;
  copyObject(input: {
    bucket?: string;
    key: string;
    srcBucket?: string;
    srcKey?: string;
    srcVersionID?: string;
    forbidOverwrite?: boolean;
  }): Promise<TosResult<{ ETag?: string }>>;
  getPreSignedUrl(input: {
    bucket?: string;
    key: string;
    method?: 'GET' | 'PUT';
    expires?: number;
    query?: Record<string, string>;
  }): string;
  createMultipartUpload(input: {
    bucket?: string;
    key: string;
    contentType?: string;
    forbidOverwrite?: boolean;
  }): Promise<TosResult<{ UploadId?: string }>>;
  completeMultipartUpload(input: {
    bucket?: string;
    key: string;
    uploadId: string;
    parts: { eTag: string; partNumber: number }[];
  }): Promise<TosResult<{ ETag?: string }>>;
  abortMultipartUpload(input: { bucket?: string; key: string; uploadId: string }): Promise<TosResult<undefined>>;
};

export function createTosClient(options: ConstructorParameters<typeof TosClient>[0]): TosClient {
  return new TosClient(options);
}

export function createTosDriver(options: {
  storageId: string;
  bucket: string;
  client: TosObjectClient;
}): StorageDriver {
  const { storageId, bucket, client } = options;

  return {
    storageId,
    capabilities: {
      put: true,
      copy: true,
      conditionalWrite: { ifNoneMatch: true },
      checksums: ['sha256', 'crc64-ecma'],
      presignMethods: ['GET', 'PUT'],
      multipart: { minPartBytes: MIN_PART_BYTES, maxPartBytes: MAX_PART_BYTES },
    },
    async put(input: DriverPut) {
      throwIfAborted(input.signal);
      try {
        const response = await client.putObject({
          bucket,
          key: input.object.key,
          body: Buffer.from(input.data),
          ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
          ...(input.precondition?.ifNoneMatch === '*' ? { forbidOverwrite: true } : {}),
        });
        return { etag: textField(response, 'etag'), checksum: sha256Checksum(input.data) };
      } catch (error) {
        throw mapTosError(error, input.signal);
      }
    },
    async stat(ref: ObjectRef): Promise<ObjectStat | null> {
      try {
        const response = await client.headObject({
          bucket,
          key: ref.key,
          ...(ref.version === undefined ? {} : { versionId: ref.version }),
        });
        return statFromHead(response);
      } catch (error) {
        const mapped = mapTosError(error);
        if (mapped.code === 'not_found') return null;
        throw mapped;
      }
    },
    async read(ref: ObjectRef) {
      try {
        const response = await client.getObject({
          bucket,
          key: ref.key,
          ...(ref.version === undefined ? {} : { versionId: ref.version }),
        });
        const data = bytesOf(response.data);
        return { data, checksum: sha256Checksum(data) };
      } catch (error) {
        throw mapTosError(error);
      }
    },
    async copy(input: DriverCopy) {
      throwIfAborted(input.signal);
      try {
        await client.copyObject({
          bucket,
          key: input.to.key,
          srcBucket: bucket,
          srcKey: input.from.key,
          ...(input.from.version === undefined ? {} : { srcVersionID: input.from.version }),
          ...(input.ifNoneMatch === '*' ? { forbidOverwrite: true } : {}),
        });
      } catch (error) {
        throw mapTosError(error, input.signal);
      }
    },
    async delete(ref: ObjectRef) {
      try {
        await client.deleteObject({
          bucket,
          key: ref.key,
          ...(ref.version === undefined ? {} : { versionId: ref.version }),
        });
      } catch (error) {
        const mapped = mapTosError(error);
        if (mapped.code === 'not_found') return;
        throw mapped;
      }
    },
    async presignPut(input: PresignPutInput): Promise<DirectUploadPlan> {
      return signPut(client, bucket, input.object.key, input.expiresInSeconds, input.contentType);
    },
    async createMultipart(input: CreateMultipartInput) {
      assertPartRequest(input.partSize, input.totalBytes);
      try {
        const response = await client.createMultipartUpload({
          bucket,
          key: input.object.key,
          ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
        });
        const uploadId = textField(response, 'UploadId') ?? uploadIdOf(response.data);
        if (!uploadId) throw new StorageError('unavailable', 'multipart upload id is missing');
        return { uploadId, partCount: partCountFor(input.partSize, input.totalBytes) };
      } catch (error) {
        throw mapTosError(error);
      }
    },
    async presignPart(input: PresignPartInput): Promise<DirectUploadPlan> {
      try {
        const url = client.getPreSignedUrl({
          bucket,
          key: input.object.key,
          method: 'PUT',
          expires: input.expiresInSeconds,
          query: { uploadId: input.uploadId, partNumber: String(input.partNumber) },
        });
        return { method: 'PUT', url, headers: {} };
      } catch (error) {
        throw mapTosError(error);
      }
    },
    async completeMultipart(input: CompleteMultipartInput) {
      const parts = normalizedParts(input.parts);
      try {
        const response = await client.completeMultipartUpload({
          bucket,
          key: input.object.key,
          uploadId: input.uploadId,
          parts: parts.map((part) => ({ eTag: part.etag, partNumber: part.partNumber })),
        });
        return { etag: textField(response, 'ETag') ?? textField(response, 'etag') };
      } catch (error) {
        throw mapTosError(error);
      }
    },
    async abortMultipart(input: AbortMultipartInput) {
      try {
        await client.abortMultipartUpload({ bucket, key: input.object.key, uploadId: input.uploadId });
      } catch (error) {
        throw mapTosError(error);
      }
    },
  };
}

function signPut(
  client: TosObjectClient,
  bucket: string,
  key: string,
  expiresInSeconds: number,
  contentType: string | undefined,
): DirectUploadPlan {
  try {
    const url = client.getPreSignedUrl({ bucket, key, method: 'PUT', expires: expiresInSeconds });
    return {
      method: 'PUT',
      url,
      headers: contentType === undefined ? {} : { 'content-type': contentType },
    };
  } catch (error) {
    throw mapTosError(error);
  }
}

function statFromHead(response: TosResult<TosHeaders>): ObjectStat {
  const length = textField(response, 'content-length');
  if (length === null) throw new StorageError('unavailable', 'object length is missing');
  const crc = textField(response, CRC64_HEADER);
  const contentType = textField(response, 'content-type');
  const checksum: Checksum | null = crc === null ? null : { algorithm: 'crc64-ecma', value: crc };
  return {
    byteLength: byteLengthOf(length),
    checksum,
    etag: textField(response, 'etag'),
    ...(contentType === null ? {} : { contentType }),
  };
}

function uploadIdOf(data: unknown): string | null {
  if (!isRecord(data) || typeof data.UploadId !== 'string' || data.UploadId.length === 0) return null;
  return data.UploadId;
}

function textField(response: unknown, name: string): string | null {
  const value = tosField(response, name);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function tosField(response: unknown, name: string): unknown {
  if (!isRecord(response)) return undefined;
  return field(response.data, name) ?? field(response.headers, name);
}

function field(source: unknown, name: string): unknown {
  if (!isRecord(source)) return undefined;
  if (Object.prototype.hasOwnProperty.call(source, name)) return source[name];
  const wanted = name.toLowerCase();
  for (const key of Object.keys(source)) {
    if (key.toLowerCase() === wanted) return source[key];
  }
  return undefined;
}

function bytesOf(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return new Uint8Array(data);
  throw new StorageError('unavailable', 'object body is missing');
}

function byteLengthOf(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  throw new StorageError('unavailable', 'object length is missing');
}

function assertPartRequest(partSize: number, totalBytes: number): void {
  if (!Number.isInteger(partSize) || partSize < 1 || !Number.isInteger(totalBytes) || totalBytes < 0) {
    throw new StorageError('config_invalid', 'partSize and totalBytes must describe the object');
  }
}

function partCountFor(partSize: number, totalBytes: number): number {
  if (totalBytes === 0) return 0;
  return Math.ceil(totalBytes / partSize);
}

function normalizedParts(
  parts: readonly { partNumber: number; etag: string }[],
): { partNumber: number; etag: string }[] {
  const seen = new Set<number>();
  for (const part of parts) {
    if (!Number.isInteger(part.partNumber) || part.partNumber < 1) {
      throw new StorageError('config_invalid', 'multipart part number is invalid');
    }
    if (part.etag.length === 0) {
      throw new StorageError('config_invalid', 'multipart part etag is empty');
    }
    if (seen.has(part.partNumber)) {
      throw new StorageError('config_invalid', 'multipart part number is duplicated');
    }
    seen.add(part.partNumber);
  }
  return [...parts].sort((left, right) => left.partNumber - right.partNumber);
}

function mapTosError(error: unknown, signal?: AbortSignal): StorageError {
  if (error instanceof StorageError) return error;
  if (cancelled(error)) return storageError('cancelled', error);
  const status = statusOf(error);
  const name = nameOf(error);
  if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') return storageError('not_found', error);
  if (status === 403 || name === 'AccessDenied' || name === 'Forbidden') return storageError('forbidden', error);
  if (status === 409 || status === 412 || name === 'PreconditionFailed') return storageError('conflict', error);
  if (signal?.aborted) return storageError('cancelled', error);
  return storageError('unavailable', error);
}

function cancelled(error: unknown): boolean {
  if (isCancel(error)) return true;
  const name = nameOf(error);
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
  return name === 'AbortError' || name === 'CancelError' || code === 'ERR_CANCELED' || code === 'ABORT_ERR';
}

function storageError(code: StorageErrorCode, error: unknown): StorageError {
  if (code === 'not_found') return new StorageError(code, 'object not found', requestIdOf(error));
  if (code === 'forbidden') return new StorageError(code, 'object access denied', requestIdOf(error));
  if (code === 'cancelled') return new StorageError(code, 'operation cancelled', requestIdOf(error));
  if (code === 'conflict') return new StorageError(code, 'object already exists', requestIdOf(error));
  return new StorageError('unavailable', 'object storage request failed', requestIdOf(error));
}

function statusOf(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  if (typeof error.statusCode === 'number') return error.statusCode;
  if (isRecord(error.$metadata) && typeof error.$metadata.httpStatusCode === 'number') {
    return error.$metadata.httpStatusCode;
  }
  if (isRecord(error.response)) {
    if (typeof error.response.status === 'number') return error.response.status;
    if (typeof error.response.statusCode === 'number') return error.response.statusCode;
  }
  if (typeof error.status === 'number') return error.status;
  return undefined;
}

function nameOf(error: unknown): string | undefined {
  if (error instanceof Error) return error.name;
  if (isRecord(error) && typeof error.name === 'string') return error.name;
  return undefined;
}

function requestIdOf(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const metadata = isRecord(error.$metadata) ? error.$metadata.requestId : undefined;
  const value = typeof error.requestId === 'string' ? error.requestId : metadata;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) return undefined;
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new StorageError('cancelled', 'operation cancelled');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
