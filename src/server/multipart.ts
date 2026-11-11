import type {
  AbortMultipartInput,
  CreateMultipartInput,
  MultipartSession,
  ObjectRef,
  StorageDriver,
} from '../core/contracts.js';
import { StorageError } from '../core/errors.js';

export type CompleteMultipartPlanInput = Readonly<{
  object: ObjectRef;
  uploadId: string;
  partCount: number;
  parts: readonly { partNumber: number; etag: string }[];
}>;

export async function createMultipartPlan(
  driver: StorageDriver,
  input: CreateMultipartInput,
): Promise<MultipartSession> {
  assertPartRequest(input.partSize, input.totalBytes);
  if (typeof driver.createMultipart !== 'function' || driver.capabilities.multipart === null) {
    throw new StorageError('capability_unsupported', 'multipart is not available');
  }
  const partCount = partCountFor(input.partSize, input.totalBytes);
  const session = await driver.createMultipart({
    object: input.object,
    partSize: input.partSize,
    totalBytes: input.totalBytes,
    ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
  });
  if (session.uploadId.length === 0) throw new StorageError('unavailable', 'multipart upload id is missing');
  return { uploadId: session.uploadId, partCount };
}

export async function completeMultipartPlan(
  driver: StorageDriver,
  input: CompleteMultipartPlanInput,
): Promise<{ etag: string | null }> {
  const parts = validatedParts(input.parts, input.partCount);
  if (typeof driver.completeMultipart !== 'function') {
    throw new StorageError('capability_unsupported', 'multipart complete is not available');
  }
  return driver.completeMultipart({
    object: input.object,
    uploadId: input.uploadId,
    parts,
  });
}

export async function abortMultipartPlan(driver: StorageDriver, input: AbortMultipartInput): Promise<void> {
  if (typeof driver.abortMultipart !== 'function') {
    throw new StorageError('capability_unsupported', 'multipart abort is not available');
  }
  await driver.abortMultipart(input);
}

function assertPartRequest(partSize: number, totalBytes: number): void {
  if (!Number.isInteger(partSize) || partSize < 1) {
    throw new StorageError('config_invalid', 'partSize must be a positive integer');
  }
  if (!Number.isInteger(totalBytes) || totalBytes < 0) {
    throw new StorageError('config_invalid', 'totalBytes must be a non-negative integer');
  }
}

function partCountFor(partSize: number, totalBytes: number): number {
  if (totalBytes === 0) return 0;
  return Math.ceil(totalBytes / partSize);
}

function validatedParts(
  parts: readonly { partNumber: number; etag: string }[],
  partCount: number,
): { partNumber: number; etag: string }[] {
  if (!Number.isInteger(partCount) || partCount < 0) {
    throw new StorageError('config_invalid', 'partCount is invalid');
  }
  const seen = new Set<number>();
  for (const part of parts) {
    if (!Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > partCount) {
      throw new StorageError('config_invalid', 'multipart part number is invalid');
    }
    if (seen.has(part.partNumber)) {
      throw new StorageError('config_invalid', 'multipart part number is duplicated');
    }
    if (part.etag.length === 0) {
      throw new StorageError('config_invalid', 'multipart part etag is empty');
    }
    seen.add(part.partNumber);
  }
  if (seen.size !== partCount) {
    throw new StorageError('config_invalid', 'multipart upload is missing parts');
  }
  return [...parts].sort((left, right) => left.partNumber - right.partNumber);
}
