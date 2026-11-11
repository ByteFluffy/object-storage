import type { DirectUploadPlan, ObjectRef, Source, StorageDriver } from '../core/contracts.js';
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
