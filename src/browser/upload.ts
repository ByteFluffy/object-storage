import type { DirectUploadPlan } from '../core/contracts.js';
import { StorageError } from '../core/errors.js';

export async function executeDirectUpload(
  plan: DirectUploadPlan,
  body: Blob,
  options: Readonly<{ fetch?: typeof fetch; signal?: AbortSignal }> = {},
): Promise<{ status: number; etag: string | null }> {
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(plan.url, {
    method: 'PUT',
    headers: { ...plan.headers },
    body,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (response.status === 403) {
    throw new StorageError('forbidden', 'direct upload failed with HTTP 403');
  }
  if (response.status === 404) {
    throw new StorageError('not_found', 'direct upload failed with HTTP 404');
  }
  if (!response.ok) {
    throw new StorageError('unavailable', `direct upload failed with HTTP ${response.status}`);
  }

  return { status: response.status, etag: response.headers.get('etag') };
}
