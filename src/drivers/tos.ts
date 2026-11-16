import { isCancel, TosClient } from '@volcengine/tos-sdk';
import { Readable } from 'node:stream';
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
  ObjectOperationOptions,
  OpenReadResult,
  ReadOptions,
  PresignPartInput,
  DirectReadPlan,
  PresignGetInput,
  PresignPutInput,
  StorageDriver,
  UploadPartInput,
} from '../core/contracts.js';
import { StorageError, type StorageErrorCode } from '../core/errors.js';
import { sha256Checksum } from '../io/hash.js';
import { openBoundedRead, readBytes } from '../io/read.js';

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

/**
 * Native TOS SDK 2.9.1 requests expose no per-request cancellation.
 * Signals gate admission; managed response streams support cancellation after headers.
 * In-flight multipart calls retain their eventual receipts.
 * Use the S3-compatible driver when physical AbortSignal cancellation is required.
 */
export type TosObjectClient = {
  putObject(input: {
    bucket?: string;
    key: string;
    body?: Buffer;
    contentType?: string;
    forbidOverwrite?: boolean;
  }): Promise<TosResult<unknown>>;
  headObject(input: { bucket?: string; key: string; versionId?: string }): Promise<TosResult<unknown>>;
  getObjectV2(input: { bucket?: string; key: string; versionId?: string; dataType: 'stream' }): Promise<TosResult<{ content: NodeJS.ReadableStream }>>;
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
  uploadPart(input: {
    bucket?: string;
    key: string;
    uploadId: string;
    partNumber: number;
    body: Buffer;
  }): Promise<TosResult<{ ETag?: string }>>;
  completeMultipartUpload(input: {
    bucket?: string;
    key: string;
    uploadId: string;
    parts: { eTag: string; partNumber: number }[];
    forbidOverwrite?: boolean;
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
  const openRead = async (ref: ObjectRef, readOptions: ReadOptions = {}): Promise<OpenReadResult> => {
    throwIfAborted(readOptions.signal);
    try {
      const response = await client.getObjectV2({
        bucket, key: ref.key, dataType: 'stream', ...(ref.version === undefined ? {} : { versionId: ref.version }),
      });
      if (!(response.data.content instanceof Readable)) throw new StorageError('unavailable', 'object body is missing');
      const byteLength = textField(response, 'content-length');
      const contentType = textField(response, 'content-type');
      // Node and DOM declarations differ on EOF result types for the same WHATWG stream.
      const body = Readable.toWeb(response.data.content) as unknown as ReadableStream<Uint8Array>;
      return openBoundedRead({ body,
        ...(byteLength === null ? {} : { byteLength: Number(byteLength) }),
        ...(contentType === null ? {} : { contentType }),
      }, readOptions);
    } catch (error) { throw mapTosError(error, readOptions.signal); }
  };

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
    async stat(ref: ObjectRef, operation: ObjectOperationOptions = {}): Promise<ObjectStat | null> {
      throwIfAborted(operation.signal);
      try {
        const response = await client.headObject({
          bucket,
          key: ref.key,
          ...(ref.version === undefined ? {} : { versionId: ref.version }),
        });
        return statFromHead(response);
      } catch (error) {
        const mapped = mapTosError(error, operation.signal);
        if (mapped.code === 'not_found') return null;
        throw mapped;
      }
    },
    openRead,
    async read(ref: ObjectRef, readOptions?: ReadOptions) { return readBytes(await openRead(ref, readOptions)); },
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
    async delete(ref: ObjectRef, operation: ObjectOperationOptions = {}) {
      throwIfAborted(operation.signal);
      try {
        await client.deleteObject({
          bucket,
          key: ref.key,
          ...(ref.version === undefined ? {} : { versionId: ref.version }),
        });
      } catch (error) {
        const mapped = mapTosError(error, operation.signal);
        if (mapped.code === 'not_found') return;
        throw mapped;
      }
    },
    async presignPut(input: PresignPutInput): Promise<DirectUploadPlan> {
      return signPut(client, bucket, input.object.key, input.expiresInSeconds, input.contentType);
    },
    async presignGet(input: PresignGetInput): Promise<DirectReadPlan> {
      return signGet(client, bucket, input.object.key, input.expiresInSeconds);
    },
    async createMultipart(input: CreateMultipartInput) {
      throwIfAborted(input.signal);
      assertPartRequest(input.partSize, input.totalBytes);
      try {
        const response = await client.createMultipartUpload({
          bucket,
          key: input.object.key,
          ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
        });
        const uploadId = textField(response, 'UploadId') ?? uploadIdOf(response.data);
        if (!uploadId) throw new StorageError('unavailable', 'multipart upload id is missing');
        return { uploadId,
          ...(input.totalBytes === undefined ? {} : { partCount: partCountFor(input.partSize, input.totalBytes) }) };
      } catch (error) {
        throw mapTosError(error, input.signal);
      }
    },
    async uploadPart(input: UploadPartInput) {
      throwIfAborted(input.signal);
      try {
        const response = await client.uploadPart({ bucket, key: input.object.key, uploadId: input.uploadId,
          partNumber: input.partNumber, body: Buffer.from(input.data) });
        const etag = textField(response, 'ETag') ?? textField(response, 'etag');
        if (!etag) throw new StorageError('unavailable', 'multipart part etag is missing');
        return { etag };
      } catch (error) {
        throw mapTosError(error, input.signal);
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
      throwIfAborted(input.signal);
      const parts = normalizedParts(input.parts);
      try {
        const response = await client.completeMultipartUpload({
          bucket,
          key: input.object.key,
          uploadId: input.uploadId,
          parts: parts.map((part) => ({ eTag: part.etag, partNumber: part.partNumber })),
          ...(input.precondition?.ifNoneMatch === '*' ? { forbidOverwrite: true } : {}),
        });
        return { etag: textField(response, 'ETag') ?? textField(response, 'etag') };
      } catch (error) {
        throw mapTosError(error, input.signal);
      }
    },
    async abortMultipart(input: AbortMultipartInput) {
      throwIfAborted(input.signal);
      try {
        await client.abortMultipartUpload({ bucket, key: input.object.key, uploadId: input.uploadId });
      } catch (error) {
        throw mapTosError(error, input.signal);
      }
    },
  };
}

function signGet(
  client: TosObjectClient,
  bucket: string,
  key: string,
  expiresInSeconds: number,
): DirectReadPlan {
  try {
    const url = client.getPreSignedUrl({ bucket, key, method: 'GET', expires: expiresInSeconds });
    return { method: 'GET', url, headers: {} };
  } catch (error) {
    throw mapTosError(error);
  }
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

function statFromHead(response: TosResult<unknown>): ObjectStat {
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

function byteLengthOf(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  throw new StorageError('unavailable', 'object length is missing');
}

function assertPartRequest(partSize: number, totalBytes: number | undefined): void {
  if (!Number.isInteger(partSize) || partSize < 1 || totalBytes !== undefined && (!Number.isInteger(totalBytes) || totalBytes < 0)) {
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
