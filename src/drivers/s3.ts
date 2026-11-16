import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type S3ClientConfig,
  type ObjectCannedACL,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  AbortMultipartInput,
  CompleteMultipartInput,
  CreateMultipartInput,
  DirectReadPlan,
  DirectUploadPlan,
  DirectAbortPlan,
  DriverCopy,
  DriverPut,
  ObjectRef,
  ObjectStat,
  ObjectOperationOptions,
  OpenReadResult,
  ReadOptions,
  PresignGetInput,
  PresignPartInput,
  PresignPutInput,
  PresignAbortMultipartInput,
  StorageDriver,
  UploadPartInput,
} from '../core/contracts.js';
import { StorageError, type StorageErrorCode } from '../core/errors.js';
import { createStorage, type Storage } from '../core/storage.js';
import { sha256Checksum } from '../io/hash.js';
import { openBoundedRead, readBytes } from '../io/read.js';

const MIN_PART_BYTES = 5 * 1024 * 1024;
const MAX_PART_BYTES = 5 * 1024 * 1024 * 1024;

type S3Command = Parameters<S3Client['send']>[0];
type SignableCommand = Parameters<typeof getSignedUrl>[1];

export type S3ObjectClient = {
  send(command: object, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
  presign(command: object, options: { expiresIn: number }): Promise<string>;
};

export type S3WriteDefaults = Readonly<{ acl?: ObjectCannedACL; cacheControl?: string }>;

export function createS3Client(config: S3ClientConfig): S3Client {
  return new S3Client(config);
}

export function createS3Storage(options: {
  storageId: string;
  bucket: string;
  endpoint: string;
  region?: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  forcePathStyle?: boolean;
  writeDefaults?: S3WriteDefaults;
}): { storage: Storage; driver: StorageDriver; close(): void } {
  const client = createS3Client({
    endpoint: options.endpoint, region: options.region ?? 'us-east-1', credentials: options.credentials,
    forcePathStyle: options.forcePathStyle ?? false,
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
  let closed = false;
  const close = () => { if (!closed) { closed = true; client.destroy(); } };
  try {
    const driver = createS3Driver({ storageId: options.storageId, bucket: options.bucket, client: bindS3Client(client), writeDefaults: options.writeDefaults });
    return { storage: createStorage({ drivers: [driver] }), driver, close };
  } catch (error) { close(); throw error; }
}

export function bindS3Client(client: S3Client): S3ObjectClient {
  return {
    send(command, options) {
      return client.send(command as S3Command, options);
    },
    presign(command, options) {
      return getSignedUrl(client, command as SignableCommand, {
        expiresIn: options.expiresIn,
        signableHeaders: new Set(['cache-control', 'x-amz-acl']),
        unhoistableHeaders: new Set(['x-amz-acl']),
      });
    },
  };
}

export function createS3Driver(options: {
  storageId: string;
  bucket: string;
  client: S3ObjectClient;
  writeDefaults?: S3WriteDefaults;
}): StorageDriver {
  const { storageId, bucket, client } = options;
  const writeMetadata = {
    ...(options.writeDefaults?.acl === undefined ? {} : { ACL: options.writeDefaults.acl }),
    ...(options.writeDefaults?.cacheControl === undefined ? {} : { CacheControl: options.writeDefaults.cacheControl }),
  };
  const openRead = async (ref: ObjectRef, readOptions: ReadOptions = {}): Promise<OpenReadResult> => {
    const output = await send(client, new GetObjectCommand({
      Bucket: bucket, Key: ref.key, ...(ref.version === undefined ? {} : { VersionId: ref.version }),
    }), readOptions.signal);
    if (!isRecord(output) || !isRecord(output.Body) || typeof output.Body.transformToWebStream !== 'function') {
      throw new StorageError('unavailable', 'object body is missing');
    }
    return openBoundedRead({
      body: output.Body.transformToWebStream(),
      ...(typeof output.ContentLength === 'number' ? { byteLength: output.ContentLength } : {}),
      ...(typeof output.ContentType === 'string' ? { contentType: output.ContentType } : {}),
    }, readOptions);
  };

  return {
    storageId,
    capabilities: {
      put: true,
      copy: true,
      conditionalWrite: { ifNoneMatch: true },
      checksums: ['sha256'],
      presignMethods: ['GET', 'PUT', 'HEAD', 'DELETE'],
      multipart: { minPartBytes: MIN_PART_BYTES, maxPartBytes: MAX_PART_BYTES },
    },
    async put(input: DriverPut) {
      const output = await send(client, new PutObjectCommand({
        Bucket: bucket,
        Key: input.object.key,
        ...writeMetadata,
        Body: input.data,
        ...(input.contentType === undefined ? {} : { ContentType: input.contentType }),
        ...(input.precondition?.ifNoneMatch === '*' ? { IfNoneMatch: '*' } : {}),
      }), input.signal);
      return { etag: etagOf(output), checksum: sha256Checksum(input.data) };
    },
    async stat(ref: ObjectRef, operation: ObjectOperationOptions = {}): Promise<ObjectStat | null> {
      try {
        const output = await send(client, new HeadObjectCommand({
          Bucket: bucket,
          Key: ref.key,
          ...(ref.version === undefined ? {} : { VersionId: ref.version }),
        }), operation.signal);
        return statFromHead(output);
      } catch (error) {
        if (error instanceof StorageError && error.code === 'not_found') return null;
        throw error;
      }
    },
    openRead,
    async read(ref: ObjectRef, readOptions?: ReadOptions) { return readBytes(await openRead(ref, readOptions)); },
    async copy(input: DriverCopy) {
      await send(client, new CopyObjectCommand({
        Bucket: bucket,
        Key: input.to.key,
        CopySource: copySource(bucket, input.from.key, input.from.version),
        ...(input.ifNoneMatch === '*' ? { IfNoneMatch: '*' } : {}),
      }), input.signal);
    },
    async delete(ref: ObjectRef, operation: ObjectOperationOptions = {}) {
      try {
        await send(client, new DeleteObjectCommand({
          Bucket: bucket,
          Key: ref.key,
          ...(ref.version === undefined ? {} : { VersionId: ref.version }),
        }), operation.signal);
      } catch (error) {
        if (error instanceof StorageError && error.code === 'not_found') return;
        throw error;
      }
    },
    async presignPut(input: PresignPutInput): Promise<DirectUploadPlan> {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: input.object.key,
        ...writeMetadata,
        ...(input.contentType === undefined ? {} : { ContentType: input.contentType }),
      });
      const url = await presign(client, command, input.expiresInSeconds);
      return {
        method: 'PUT',
        url,
        headers: {
          ...(input.contentType === undefined ? {} : { 'content-type': input.contentType }),
          ...(writeMetadata.ACL === undefined ? {} : { 'x-amz-acl': writeMetadata.ACL }),
          ...(writeMetadata.CacheControl === undefined ? {} : { 'cache-control': writeMetadata.CacheControl }),
        },
      };
    },
    async presignGet(input: PresignGetInput): Promise<DirectReadPlan> {
      const command = new GetObjectCommand({ Bucket: bucket, Key: input.object.key });
      const url = await presign(client, command, input.expiresInSeconds);
      return { method: 'GET', url, headers: {} };
    },
    async presignAbortMultipart(input: PresignAbortMultipartInput): Promise<DirectAbortPlan> {
      const command = new AbortMultipartUploadCommand({ Bucket: bucket, Key: input.object.key, UploadId: input.uploadId });
      const url = await presign(client, command, input.expiresInSeconds);
      return { method: 'DELETE', url, headers: {} };
    },
    async createMultipart(input: CreateMultipartInput) {
      assertPartRequest(input.partSize, input.totalBytes);
      const output = await send(client, new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: input.object.key,
        ...writeMetadata,
        ...(input.contentType === undefined ? {} : { ContentType: input.contentType }),
      }), input.signal);
      if (!isRecord(output) || typeof output.UploadId !== 'string' || output.UploadId.length === 0) {
        throw new StorageError('unavailable', 'multipart upload id is missing');
      }
      return { uploadId: output.UploadId,
        ...(input.totalBytes === undefined ? {} : { partCount: partCountFor(input.partSize, input.totalBytes) }) };
    },
    async uploadPart(input: UploadPartInput) {
      const output = await send(client, new UploadPartCommand({
        Bucket: bucket,
        Key: input.object.key,
        UploadId: input.uploadId,
        PartNumber: input.partNumber,
        Body: input.data,
        ContentLength: input.data.byteLength,
      }), input.signal);
      const etag = etagOf(output);
      if (!etag) throw new StorageError('unavailable', 'multipart part etag is missing');
      return { etag };
    },
    async presignPart(input: PresignPartInput): Promise<DirectUploadPlan> {
      const command = new UploadPartCommand({
        Bucket: bucket,
        Key: input.object.key,
        UploadId: input.uploadId,
        PartNumber: input.partNumber,
      });
      const url = await presign(client, command, input.expiresInSeconds);
      return { method: 'PUT', url, headers: {} };
    },
    async completeMultipart(input: CompleteMultipartInput) {
      const parts = normalizedParts(input.parts);
      const output = await send(client, new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: input.object.key,
        UploadId: input.uploadId,
        ...(input.precondition?.ifNoneMatch === '*' ? { IfNoneMatch: '*' } : {}),
        MultipartUpload: {
          Parts: parts.map((part) => ({ ETag: part.etag, PartNumber: part.partNumber })),
        },
      }), input.signal);
      return { etag: etagOf(output) };
    },
    async abortMultipart(input: AbortMultipartInput) {
      await send(client, new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: input.object.key,
        UploadId: input.uploadId,
      }), input.signal);
    },
  };
}

async function send(client: S3ObjectClient, command: object, signal?: AbortSignal): Promise<unknown> {
  throwIfAborted(signal);
  try {
    return await (signal === undefined ? client.send(command) : client.send(command, { abortSignal: signal }));
  } catch (error) {
    throw mapS3Error(error, signal);
  }
}

async function presign(client: S3ObjectClient, command: object, expiresInSeconds: number): Promise<string> {
  try {
    return await client.presign(command, { expiresIn: expiresInSeconds });
  } catch (error) {
    throw mapS3Error(error);
  }
}

function statFromHead(output: unknown): ObjectStat {
  if (!isRecord(output)) throw new StorageError('unavailable', 'object metadata is missing');
  const contentType = typeof output.ContentType === 'string' ? output.ContentType : undefined;
  return {
    byteLength: byteLengthOf(output.ContentLength),
    checksum: null,
    etag: etagOf(output),
    ...(contentType === undefined ? {} : { contentType }),
  };
}

function etagOf(output: unknown): string | null {
  if (!isRecord(output) || typeof output.ETag !== 'string' || output.ETag.length === 0) return null;
  return output.ETag;
}

function copySource(bucket: string, key: string, version: string | undefined): string {
  const encoded = key.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const source = `${bucket}/${encoded}`;
  return version === undefined ? source : `${source}?versionId=${encodeURIComponent(version)}`;
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

function mapS3Error(error: unknown, signal?: AbortSignal): StorageError {
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
