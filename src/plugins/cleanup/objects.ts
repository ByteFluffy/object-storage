import type { ObjectRef, StorageDriver } from '../../core/contracts.js';

export type CleanObjectItem = Readonly<{
  ref: ObjectRef;
  generation: string;
}>;

export type CleanUploadItem = Readonly<{
  ref: ObjectRef;
  uploadId: string;
}>;

export type CleanFailureCode =
  | 'stale_receipt'
  | 'storage_mismatch'
  | 'delete_failed'
  | 'capability_unsupported';

export type CleanObjectResult = Readonly<{
  ref: ObjectRef;
  status: 'deleted' | 'not_found' | 'failed' | 'aborted';
  code?: CleanFailureCode;
  uploadId?: string;
}>;

export async function cleanObjects(
  input: Readonly<{
    driver: StorageDriver;
    items: readonly CleanObjectItem[];
    uploads?: readonly CleanUploadItem[];
    currentGeneration: (ref: ObjectRef) => string | null | Promise<string | null>;
  }>,
): Promise<CleanObjectResult[]> {
  const results: CleanObjectResult[] = [];
  for (const item of input.items) {
    if (item.ref.storageId !== input.driver.storageId) {
      results.push({ ref: item.ref, status: 'failed', code: 'storage_mismatch' });
      continue;
    }
    const generation = await input.currentGeneration(item.ref);
    if (generation === null) {
      results.push({ ref: item.ref, status: 'not_found' });
      continue;
    }
    if (generation !== item.generation) {
      results.push({ ref: item.ref, status: 'failed', code: 'stale_receipt' });
      continue;
    }
    try {
      await input.driver.delete(item.ref);
    } catch {
      results.push({ ref: item.ref, status: 'failed', code: 'delete_failed' });
      continue;
    }
    results.push({ ref: item.ref, status: 'deleted' });
  }

  for (const upload of input.uploads ?? []) {
    if (upload.ref.storageId !== input.driver.storageId) {
      results.push({ ref: upload.ref, status: 'failed', code: 'storage_mismatch', uploadId: upload.uploadId });
      continue;
    }
    if (typeof input.driver.abortMultipart !== 'function') {
      results.push({
        ref: upload.ref,
        status: 'failed',
        code: 'capability_unsupported',
        uploadId: upload.uploadId,
      });
      continue;
    }
    try {
      await input.driver.abortMultipart({ object: upload.ref, uploadId: upload.uploadId });
    } catch {
      results.push({ ref: upload.ref, status: 'failed', code: 'delete_failed', uploadId: upload.uploadId });
      continue;
    }
    results.push({ ref: upload.ref, status: 'aborted', uploadId: upload.uploadId });
  }
  return results;
}
