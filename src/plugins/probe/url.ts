import type { Checksum } from '../../core/contracts.js';
import { StorageError } from '../../core/errors.js';
import type { ProbeResult } from '../../core/plugin.js';
import { sha256Checksum } from '../../io/hash.js';

type ProbeFetchInit = Readonly<{
  method: 'GET' | 'HEAD';
  redirect: 'manual';
  signal?: AbortSignal;
}>;

export async function checkUrl(
  input: Readonly<{
    url: string;
    method: 'GET' | 'HEAD';
    fetch: (url: string, init: ProbeFetchInit) => Promise<Response>;
    signatureMethod?: 'GET' | 'PUT' | 'HEAD';
    expectedChecksum?: Checksum;
    expectedMediaType?: string;
    maxBytes?: number;
    signal?: AbortSignal;
    now?: () => number;
  }>,
): Promise<ProbeResult> {
  // A presigned GET URL is method-bound, so HEAD would not be the signed request.
  if (input.signatureMethod === 'GET' && input.method === 'HEAD') {
    throw new StorageError('config_invalid', safeMessage('HEAD probe cannot use a GET signature', input.url));
  }
  if (input.signal?.aborted) {
    throw new StorageError('cancelled', safeMessage('operation cancelled', input.url));
  }

  const checkedAt = new Date(input.now?.() ?? Date.now()).toISOString();
  let response: Response;
  try {
    response = await input.fetch(input.url, {
      method: input.method,
      redirect: 'manual',
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'url probe failed';
    if (error instanceof StorageError && (error.code === 'cancelled' || error.code === 'config_invalid')) {
      throw new StorageError(error.code, safeMessage(message, input.url), error.requestId);
    }
    throw new StorageError('unavailable', safeMessage(message, input.url));
  }

  if (isRedirect(response.status)) return { status: 'redirected', checkedAt };
  if (response.status === 403) return { status: 'forbidden', checkedAt, code: 'forbidden' };
  if (response.status === 404) return { status: 'not_found', checkedAt, code: 'not_found' };
  if (response.status !== 200) return { status: 'unavailable', checkedAt, code: 'unavailable' };

  const mediaType = mediaTypeEssence(response.headers.get('content-type'));
  if (input.expectedMediaType !== undefined && mediaTypeEssence(input.expectedMediaType) !== mediaType) {
    return { status: 'mismatch', checkedAt, ...(mediaType === undefined ? {} : { mediaType }) };
  }

  if (input.method === 'HEAD') {
    if (input.expectedChecksum) {
      return {
        status: 'mismatch',
        checkedAt,
        ...(mediaType === undefined ? {} : { mediaType }),
        code: 'checksum_unavailable',
      };
    }
    const byteLength = contentLength(response.headers.get('content-length'));
    return {
      status: 'passed',
      checkedAt,
      ...(byteLength === undefined ? {} : { byteLength }),
      ...(mediaType === undefined ? {} : { mediaType }),
    };
  }

  const data = new Uint8Array(await response.arrayBuffer());
  if (input.maxBytes !== undefined && data.byteLength > input.maxBytes) {
    return {
      status: 'mismatch',
      checkedAt,
      byteLength: data.byteLength,
      ...(mediaType === undefined ? {} : { mediaType }),
      code: 'input_too_large',
    };
  }

  const checksum = sha256Checksum(data);
  if (
    input.expectedChecksum !== undefined &&
    (checksum.algorithm !== input.expectedChecksum.algorithm || checksum.value !== input.expectedChecksum.value)
  ) {
    return {
      status: 'mismatch',
      checkedAt,
      byteLength: data.byteLength,
      checksum,
      ...(mediaType === undefined ? {} : { mediaType }),
      code: 'checksum_mismatch',
    };
  }

  return {
    status: 'passed',
    checkedAt,
    byteLength: data.byteLength,
    checksum,
    ...(mediaType === undefined ? {} : { mediaType }),
  };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function mediaTypeEssence(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  const essence = value.split(';', 1)[0]?.trim().toLowerCase();
  return essence === undefined || essence.length === 0 ? undefined : essence;
}

function contentLength(value: string | null): number | undefined {
  if (value === null || !/^[0-9]+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function safeMessage(message: string, url: string): string {
  const sanitized = withoutUrlQuery(message, url).trim();
  return sanitized.length > 0 ? sanitized : 'url probe failed';
}

function withoutUrlQuery(message: string, url: string): string {
  let sanitized = message;
  const queryAt = url.indexOf('?');
  if (queryAt >= 0) {
    const query = url.slice(queryAt);
    const rawQuery = query.slice(1);
    sanitized = sanitized.split(url).join(url.slice(0, queryAt));
    if (query.length > 0) sanitized = sanitized.split(query).join('');
    if (rawQuery.length > 0) sanitized = sanitized.split(rawQuery).join('');
    sanitized = stripQueryValues(sanitized, rawQuery);
  }
  try {
    const parsed = new URL(url);
    if (parsed.search.length > 0) {
      sanitized = sanitized.split(parsed.href).join(`${parsed.origin}${parsed.pathname}`);
      sanitized = sanitized.split(parsed.search).join('');
      const rawQuery = parsed.search.slice(1);
      if (rawQuery.length > 0) sanitized = sanitized.split(rawQuery).join('');
      for (const value of parsed.searchParams.values()) {
        if (value.length > 0) sanitized = sanitized.split(value).join('');
      }
    }
  } catch {
    // The raw string above already dropped any query the URL parser cannot read.
  }
  return sanitized;
}

function stripQueryValues(message: string, rawQuery: string): string {
  if (rawQuery.length === 0) return message;
  let sanitized = message;
  for (const part of rawQuery.split('&')) {
    const separator = part.indexOf('=');
    const value = separator >= 0 ? part.slice(separator + 1) : part;
    if (value.length === 0) continue;
    sanitized = sanitized.split(value).join('');
    try {
      const decoded = decodeURIComponent(value);
      if (decoded.length > 0 && decoded !== value) sanitized = sanitized.split(decoded).join('');
    } catch {
      // Keep the raw value removal when the query value is not valid percent-encoding.
    }
  }
  return sanitized;
}
