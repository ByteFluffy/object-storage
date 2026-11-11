import { describe, expect, it } from 'vitest';
import { executeDirectUpload } from '../../src/browser/upload.js';

describe('executeDirectUpload', () => {
  it('sends the plan with PUT and returns the etag', async () => {
    const body = new Blob([new TextEncoder().encode('abc')]);
    let seenMethod = '';
    let seenHeader = '';
    const fetchImpl: typeof fetch = async (_url, init) => {
      seenMethod = init?.method ?? '';
      seenHeader = new Headers(init?.headers).get('content-type') ?? '';
      return new Response(null, { status: 200, headers: { etag: '"abc-etag"' } });
    };

    const result = await executeDirectUpload(
      {
        method: 'PUT',
        url: 'https://bucket.example/temp/abc?X-Amz-Signature=supersecret',
        headers: { 'content-type': 'text/plain' },
      },
      body,
      { fetch: fetchImpl },
    );

    expect(seenMethod).toBe('PUT');
    expect(seenHeader).toBe('text/plain');
    expect(result).toEqual({ status: 200, etag: '"abc-etag"' });
  });

  it('omits the signed url from an error', async () => {
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 403 });

    await expect(
      executeDirectUpload(
        {
          method: 'PUT',
          url: 'https://bucket.example/temp/abc?X-Amz-Signature=supersecret',
          headers: {},
        },
        new Blob(['abc']),
        { fetch: fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    try {
      await executeDirectUpload(
        {
          method: 'PUT',
          url: 'https://bucket.example/temp/abc?X-Amz-Signature=supersecret',
          headers: {},
        },
        new Blob(['abc']),
        { fetch: fetchImpl },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('supersecret');
    }
  });
});
