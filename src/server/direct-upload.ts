import type { DirectReadPlan, DirectUploadPlan, ObjectRef, Source, StorageDriver } from '../core/contracts.js';
import { StorageError } from '../core/errors.js';

export type SinglePutPlanInput = Readonly<{
  object: ObjectRef;
  contentType?: string;
  expiresInSeconds: number;
  source?: Source;
  method?: 'GET' | 'PUT' | 'HEAD';
}>;

export async function createSinglePutPlan(
  driver: StorageDriver,
  input: SinglePutPlanInput,
): Promise<DirectUploadPlan> {
  if (input.method !== undefined && input.method !== 'PUT') {
    throw new StorageError('capability_unsupported', `${input.method} presign is not available`);
  }
  if (typeof driver.presignPut !== 'function') {
    throw new StorageError('capability_unsupported', 'presign put is not available');
  }
  return driver.presignPut({
    object: input.object,
    expiresInSeconds: input.expiresInSeconds,
    ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
  });
}

export type SingleGetPlanInput = Readonly<{
  object: ObjectRef;
  expiresInSeconds: number;
}>;

export async function createSingleGetPlan(
  driver: StorageDriver,
  input: SingleGetPlanInput,
): Promise<DirectReadPlan> {
  assertExpires(input.expiresInSeconds);
  if (!driver.capabilities.presignMethods.includes('GET') || typeof driver.presignGet !== 'function') {
    throw new StorageError('capability_unsupported', 'presign get is not available');
  }
  return driver.presignGet({
    object: input.object,
    expiresInSeconds: input.expiresInSeconds,
  });
}

function assertExpires(expiresInSeconds: number): void {
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1) {
    throw new StorageError('config_invalid', 'expiresInSeconds must be a positive integer');
  }
}
