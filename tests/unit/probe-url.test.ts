import { describe, expect, it, vi } from 'vitest';
import { StorageError } from '../../src/core/errors.js';
import { sha256Checksum } from '../../src/io/hash.js';
import { checkUrl } from '../../src/plugins/probe/index.js';

const SECRET_URL = 'https://cdn.example/object.bin?X-Amz-Signature=secret-value&X-Amz-Credential=hidden';

describe('checkUrl', () => {
  it('passes an explicit unsigned HEAD availability check without claiming a checksum', async () => {
    const response = new Response(null, { status: 200, headers: {
      'content-type': 'image/png; charset=binary', 'content-length': '123', etag: '"not-a-checksum"',
    } });
    const readBody = vi.spyOn(response, 'arrayBuffer');
    const fetch = vi.fn(async () => response);
    const result = await checkUrl({
      url: 'https://cdn.example/image.png', method: 'HEAD', signatureMethod: 'unsigned',
      verification: 'availability', expectedMediaType: 'image/png', fetch,
      now: () => Date.parse('2024-01-02T03:04:05.000Z'),
    });

    expect(result).toEqual({ status: 'passed', httpStatus: 200, checkedAt: '2024-01-02T03:04:05.000Z', byteLength: 123, mediaType: 'image/png' });
    expect(result.checksum).toBeUndefined();
    expect(readBody).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://cdn.example/image.png', { method: 'HEAD', redirect: 'manual' });
  });

  it('allows an actual HEAD signature for availability without exposing its query', async () => {
    const result = await checkUrl({
      url: SECRET_URL, method: 'HEAD', signatureMethod: 'HEAD', verification: 'availability',
      fetch: async () => new Response(null, { status: 200 }),
    });
    expect(result.status).toBe('passed');
    expect(result.checksum).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it.each([
    { status: 200, expected: 'passed' }, { status: 403, expected: 'forbidden' },
    { status: 404, expected: 'not_found' }, { status: 302, expected: 'redirected' },
    { status: 500, expected: 'unavailable' },
  ])('releases unread GET availability bodies for HTTP $status without claiming verified content', async ({ status, expected }) => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); }, cancel,
    }), { status });
    const readBody = vi.spyOn(response, 'arrayBuffer');
    const result = await checkUrl({
      url: 'https://cdn.example/note.txt', method: 'GET', signatureMethod: 'unsigned',
      verification: 'availability', fetch: async () => response,
    });
    expect(result.status).toBe(expected);
    expect(result.httpStatus).toBe(status);
    expect(result.checksum).toBeUndefined();
    expect(result.byteLength).toBeUndefined();
    expect(readBody).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.bodyUsed).toBe(true);
  });

  it('uses the existing sanitized failure path when releasing an availability body fails', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); },
      cancel: () => { throw new Error(`cancel failed for ${SECRET_URL}`); },
    }));
    const error = await checkUrl({
      url: SECRET_URL, method: 'GET', signatureMethod: 'GET', verification: 'availability',
      fetch: async () => response,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'unavailable' });
    expect(error instanceof Error ? error.message : error).not.toContain('secret-value');
  });

  it('keeps checksum verification as the default for an unsigned HEAD', async () => {
    const result = await checkUrl({
      url: 'https://cdn.example/note.txt', method: 'HEAD', signatureMethod: 'unsigned',
      fetch: async () => new Response(null, { status: 200 }),
    });
    expect(result).toMatchObject({ status: 'mismatch', code: 'checksum_unavailable', httpStatus: 200 });
    expect(result.checksum).toBeUndefined();
  });

  it.each(['GET', 'HEAD'] as const)('rejects expectedChecksum with %s availability before fetching', async method => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(checkUrl({
      url: SECRET_URL, method, signatureMethod: method, verification: 'availability',
      expectedChecksum: sha256Checksum(new Uint8Array()), fetch,
    })).rejects.toMatchObject({ code: 'config_invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([SECRET_URL, 'https://cdn.example/note.txt?cache=secret-value', 'https://cdn.example/note.txt?'])(
    'rejects a query on an explicitly unsigned URL before fetching (%s)', async url => {
      const fetch = vi.fn(async () => new Response(null, { status: 200 }));
      const error = await checkUrl({
        url, method: 'HEAD', signatureMethod: 'unsigned', verification: 'availability', fetch,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(StorageError);
      expect(error).toMatchObject({ code: 'config_invalid' });
      expect(error instanceof Error ? error.message : error).not.toContain('secret-value');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(['GET', 'PUT', undefined] as const)('keeps HEAD method binding for availability with signature %s', async signatureMethod => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(checkUrl({
      url: SECRET_URL, method: 'HEAD', signatureMethod, verification: 'availability', fetch,
    })).rejects.toMatchObject({ code: 'config_invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { status: 403, expected: 'forbidden' }, { status: 404, expected: 'not_found' },
    { status: 301, expected: 'redirected' }, { status: 302, expected: 'redirected' },
    { status: 303, expected: 'redirected' }, { status: 307, expected: 'redirected' },
    { status: 308, expected: 'redirected' }, { status: 500, expected: 'unavailable' },
    { status: 400, expected: 'unavailable' }, { status: 401, expected: 'unavailable' },
    { status: 408, expected: 'unavailable' }, { status: 409, expected: 'unavailable' },
    { status: 422, expected: 'unavailable' }, { status: 429, expected: 'unavailable' },
    { status: 503, expected: 'unavailable' }, { status: 504, expected: 'unavailable' },
  ])('preserves HTTP $status semantics for public availability', async ({ status, expected }) => {
    const result = await checkUrl({
      url: 'https://cdn.example/note.txt', method: 'HEAD', signatureMethod: 'unsigned', verification: 'availability',
      fetch: async (_url, init) => {
        expect(init.redirect).toBe('manual');
        return new Response(null, { status, headers: { location: SECRET_URL } });
      },
    });
    expect(result.status).toBe(expected);
    expect(result.httpStatus).toBe(status);
    expect(result.checksum).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it('keeps media type constraints for public availability', async () => {
    const result = await checkUrl({
      url: 'https://cdn.example/image.png', method: 'HEAD', signatureMethod: 'unsigned',
      verification: 'availability', expectedMediaType: 'image/png',
      fetch: async () => new Response(null, { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    expect(result).toMatchObject({ status: 'mismatch', mediaType: 'text/html', httpStatus: 200 });
    expect(result.checksum).toBeUndefined();
  });

  it('rejects an already aborted public availability request without fetching', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(checkUrl({
      url: 'https://cdn.example/note.txt', method: 'HEAD', signatureMethod: 'unsigned', verification: 'availability',
      signal: AbortSignal.abort(), fetch,
    })).rejects.toMatchObject({ code: 'cancelled' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves sanitized fetch failures for signed availability', async () => {
    const error = await checkUrl({
      url: SECRET_URL, method: 'HEAD', signatureMethod: 'HEAD', verification: 'availability',
      fetch: async () => { throw new Error(`request failed for ${SECRET_URL}`); },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'unavailable' });
    expect(error).not.toHaveProperty('httpStatus');
    expect(error instanceof Error ? error.message : error).not.toContain('secret-value');
  });

  it('rejects a HEAD probe signed for GET before fetch', async () => {
    let calls = 0;
    const error = await checkUrl({
      url: SECRET_URL,
      method: 'HEAD',
      signatureMethod: 'GET',
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 200 });
      },
    }).then(
      () => {
        throw new Error('expected config_invalid');
      },
      (caught: unknown) => caught,
    );

    expect(calls).toBe(0);
    expect(error).toBeInstanceOf(StorageError);
    expect(error).toMatchObject({ code: 'config_invalid' });
    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toContain('secret-value');
    expect(message).not.toContain('X-Amz-Signature');
    expect(message).not.toContain('?');
  });

  it.each([301, 302])('reports HTTP %s as redirected and does not follow it', async (status) => {
    let calls = 0;
    const body = new TextEncoder().encode('abc');
    const checksum = sha256Checksum(body);
    const result = await checkUrl({
      url: SECRET_URL,
      method: 'GET',
      expectedChecksum: checksum,
      expectedMediaType: 'image/png',
      now: () => Date.parse('2024-01-02T03:04:05.000Z'),
      fetch: async (_url, init) => {
        calls += 1;
        expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
        return new Response(body, {
          status,
          headers: { location: 'https://cdn.example/other.bin?token=secret-value', 'content-type': 'image/png' },
        });
      },
    });

    expect(calls).toBe(1);
    expect(result.status).toBe('redirected');
    expect(result.httpStatus).toBe(status);
    expect(result.status).not.toBe('passed');
    expect(result.checkedAt).toBe('2024-01-02T03:04:05.000Z');
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it('maps 403 to forbidden and 404 to not_found', async () => {
    const forbidden = await checkUrl({
      url: SECRET_URL,
      method: 'GET',
      fetch: async () => new Response('no', { status: 403, headers: { 'content-type': 'text/html' } }),
    });
    const missing = await checkUrl({
      url: SECRET_URL,
      method: 'HEAD',
      signatureMethod: 'HEAD',
      fetch: async () => new Response(null, { status: 404 }),
    });

    expect(forbidden.status).toBe('forbidden');
    expect(missing.status).toBe('not_found');
    expect(forbidden.httpStatus).toBe(403); expect(missing.httpStatus).toBe(404);
    expect(JSON.stringify(forbidden)).not.toContain('secret-value');
    expect(JSON.stringify(missing)).not.toContain('?');
  });

  it('mismatches an HTML body when an image was expected', async () => {
    const result = await checkUrl({
      url: 'https://cdn.example/cat.png',
      method: 'GET',
      expectedMediaType: 'image/png',
      fetch: async () =>
        new Response('<html>login</html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8', etag: '"not-a-checksum"' },
        }),
    });

    expect(result.status).toBe('mismatch');
    expect(result.httpStatus).toBe(200);
    expect(result.status).not.toBe('passed');
  });

  it('passes only a GET body whose SHA-256 matches, and ignores etag', async () => {
    const body = new TextEncoder().encode('abc');
    const checksum = sha256Checksum(body);
    const etag = '"etag-not-checksum"';
    const matched = await checkUrl({
      url: 'https://cdn.example/note.txt',
      method: 'GET',
      expectedChecksum: checksum,
      expectedMediaType: 'text/plain',
      fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain', etag } }),
    });
    const different = await checkUrl({
      url: 'https://cdn.example/note.txt',
      method: 'GET',
      expectedChecksum: { algorithm: 'sha256', value: 'b'.repeat(64) },
      fetch: async () => new Response(body, { status: 200, headers: { etag } }),
    });

    expect(matched.status).toBe('passed');
    expect(matched.httpStatus).toBe(200);
    expect(matched.checksum).toEqual(checksum);
    expect(JSON.stringify(matched)).not.toContain('etag-not-checksum');
    expect(different.status).toBe('mismatch');
    expect(different.httpStatus).toBe(200);
    expect(different.status).not.toBe('passed');
    expect(different.checksum).toEqual(checksum);
  });

  it('strips the query string from a fetch failure', async () => {
    const error = await checkUrl({
      url: SECRET_URL,
      method: 'GET',
      fetch: async () => {
        throw new Error(`request failed for ${SECRET_URL}`);
      },
    }).then(
      () => {
        throw new Error('expected failure');
      },
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toContain('secret-value');
    expect(message).not.toContain('X-Amz-Signature');
    expect(message).not.toContain('hidden');
    expect(message).not.toContain('?');
  });

  it('does not pass when the body exceeds maxBytes', async () => {
    const result = await checkUrl({
      url: 'https://cdn.example/blob.bin',
      method: 'GET',
      maxBytes: 4,
      expectedChecksum: sha256Checksum(new Uint8Array(8)),
      fetch: async () => new Response(new Uint8Array(8), { status: 200 }),
    });

    expect(result.status).not.toBe('passed');
    expect(result.httpStatus).toBe(200);
  });

  it('rejects HEAD without a HEAD signature before fetch', async () => {
    let calls = 0;
    await expect(
      checkUrl({
        url: SECRET_URL,
        method: 'HEAD',
        fetch: async () => {
          calls += 1;
          return new Response(null, { status: 200 });
        },
      }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    expect(calls).toBe(0);
  });

  it('does not treat a signed HEAD 200 as verified content', async () => {
    const result = await checkUrl({
      url: 'https://cdn.example/note.txt',
      method: 'HEAD',
      signatureMethod: 'HEAD',
      fetch: async () =>
        new Response(null, {
          status: 200,
          headers: { 'content-type': 'text/plain', 'content-length': '3', etag: '"not-a-checksum"' },
        }),
    });

    expect(result.status).not.toBe('passed');
    expect(result.code).toBe('checksum_unavailable');
    expect(JSON.stringify(result)).not.toContain('not-a-checksum');
  });

  it('does not pass expectedChecksum for HEAD', async () => {
    const body = new TextEncoder().encode('abc');
    const checksum = sha256Checksum(body);
    const result = await checkUrl({
      url: 'https://cdn.example/note.txt',
      method: 'HEAD',
      signatureMethod: 'HEAD',
      expectedChecksum: checksum,
      fetch: async (_url, init) => {
        expect(init.redirect).toBe('manual');
        expect(init.method).toBe('HEAD');
        return new Response(body, {
          status: 200,
          headers: { etag: checksum.value, 'content-type': 'text/plain', 'content-length': '3' },
        });
      },
    });

    expect(result.status).not.toBe('passed');
    expect(result.checksum?.value).not.toBe(checksum.value);
  });

  it('does not fetch when the signal is already aborted', async () => {
    let calls = 0;
    const error = await checkUrl({
      url: SECRET_URL,
      method: 'GET',
      signal: AbortSignal.abort(),
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 200 });
      },
    }).then(
      () => {
        throw new Error('expected cancelled');
      },
      (caught: unknown) => caught,
    );

    expect(calls).toBe(0);
    expect(error).toMatchObject({ code: 'cancelled' });
    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toContain('secret-value');
  });
});
