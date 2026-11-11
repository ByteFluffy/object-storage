import type { ObjectRef, StorageDriver } from '../../core/contracts.js';

export type CleanObjectItem = Readonly<{
  ref: ObjectRef;
  generation: string;
}>;

export type CleanObjectResult = Readonly<{
  ref: ObjectRef;
  status: 'deleted' | 'not_found' | 'failed';
  code?: 'stale_receipt';
}>;

export async function cleanObjects(
  input: Readonly<{
    driver: StorageDriver;
    items: readonly CleanObjectItem[];
    currentGeneration: (ref: ObjectRef) => string | null | Promise<string | null>;
  }>,
): Promise<CleanObjectResult[]> {
  const results: CleanObjectResult[] = [];
  for (const item of input.items) {
    const generation = await input.currentGeneration(item.ref);
    if (generation === null) {
      results.push({ ref: item.ref, status: 'not_found' });
      continue;
    }
    if (generation !== item.generation) {
      results.push({ ref: item.ref, status: 'failed', code: 'stale_receipt' });
      continue;
    }
    await input.driver.delete(item.ref);
    results.push({ ref: item.ref, status: 'deleted' });
  }
  return results;
}
