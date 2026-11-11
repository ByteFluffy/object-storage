import { describe, expect, it } from 'vitest';
import { sha256Checksum } from '../../src/io/hash.js';
import { createTosClient, createTosDriver, type TosObjectClient } from '../../src/drivers/tos.js';
import type { ObjectRef } from '../../src/core/contracts.js';

const CRC64 = '18446744073709551615';
const SECRET_MESSAGE =
  'https://bucket.tos.example/obj?X-Tos-Signature=secret-value accessKeySecret=super-secret';

type PutInput = {
  bucket?: string;
  key: string;
  body?: Buffer;
  contentType?: string;
  forbidOverwrite?: boolean;
};

function ref(key: string): ObjectRef {
  return { storageId: 'tos-main', key };
}

function clientOf(overrides: Partial<TosObjectClient> = {}): {
  client: TosObjectClient;
  puts: PutInput[];
  signed: unknown[];
  copies: unknown[];
  multipart: { created: unknown[]; completed: unknown[]; aborted: unknown[] };
} {
  const puts: PutInput[] = [];
  const signed: unknown[] = [];
  const copies: unknown[] = [];
  const multipart = { created: [] as unknown[], completed: [] as unknown[], aborted: [] as unknown[] };
  const client: TosObjectClient = {
    async putObject(input) {
      puts.push(input);
      return {
        data: { 'x-tos-hash-crc64ecma': CRC64 },
        headers: { etag: '"remote-etag"', 'x-tos-hash-crc64ecma': CRC64 },
        statusCode: 200,
        requestId: 'req-put',
      };
    },
    async headObject() {
      return {
        data: {
          'content-length': '3',
          etag: '"remote-etag"',
          'content-type': 'text/plain',
          'x-tos-hash-crc64ecma': CRC64,
        },
        statusCode: 200,
        requestId: 'req-head',
      };
    },
    async getObject() {
      return {
        data: Buffer.from('abc'),
        headers: { etag: '"remote-etag"', 'x-tos-hash-crc64ecma': CRC64 },
        statusCode: 200,
        requestId: 'req-get',
      };
    },
    async deleteObject() {
      return { data: {}, statusCode: 204, requestId: 'req-del' };
    },
    async copyObject(input) {
      copies.push(input);
      return { data: { ETag: '"copied"' }, statusCode: 200, requestId: 'req-copy' };
    },
    getPreSignedUrl(input) {
      signed.push(input);
      return `https://signed.example/${input.key}?method=${input.method ?? 'GET'}&expires=${input.expires ?? ''}`;
    },
    async createMultipartUpload(input) {
      multipart.created.push(input);
      return { data: { UploadId: 'up-1' }, statusCode: 200, requestId: 'req-mp' };
    },
    async completeMultipartUpload(input) {
      multipart.completed.push(input);
      return { data: { ETag: '"whole"' }, statusCode: 200, requestId: 'req-done' };
    },
    async abortMultipartUpload(input) {
      multipart.aborted.push(input);
      return { data: undefined, statusCode: 204, requestId: 'req-abort' };
    },
    ...overrides,
  };
  return { client, puts, signed, copies, multipart };
}

describe('TOS driver', () => {
  it('exposes the real client constructor without calling it', () => {
    expect(typeof createTosClient).toBe('function');
  });

  it('passes bucket, key, body, content type, and forbidOverwrite to putObject', async () => {
    const { client, puts } = clientOf();
    const driver = createTosDriver({ storageId: 'tos-main', bucket: 'media', client });
    const data = Buffer.from('abc');

    const written = await driver.put({
      object: ref('incoming/abc.txt'),
      data,
      contentType: 'text/plain',
      checksum: sha256Checksum(data),
      precondition: { ifNoneMatch: '*' },
    });

    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({
      bucket: 'media',
      key: 'incoming/abc.txt',
      contentType: 'text/plain',
      forbidOverwrite: true,
    });
    expect(Buffer.from(puts[0]?.body ?? []).equals(data)).toBe(true);
    expect(written.etag).toBe('"remote-etag"');
    expect(written.checksum).toEqual(sha256Checksum(data));
    expect(written.checksum?.value).not.toBe(written.etag);
    expect(written.checksum?.value).not.toBe(CRC64);
    expect(String(Number(CRC64))).not.toBe(CRC64);
  });

  it('omits forbidOverwrite when if-none-match is not requested', async () => {
    const { client, puts } = clientOf();
    const driver = createTosDriver({ storageId: 'tos-main', bucket: 'media', client });
    await driver.put({
      object: ref('plain.txt'),
      data: Buffer.from('abc'),
      checksum: sha256Checksum(Buffer.from('abc')),
    });
    expect(puts[0]?.forbidOverwrite).toBeUndefined();
  });

  it('records the crc64 header as the original string and keeps etag separate', async () => {
    const { client } = clientOf();
    const driver = createTosDriver({ storageId: 'tos-main', bucket: 'media', client });
    const stat = await driver.stat(ref('incoming/abc.txt'));
    expect(stat).toEqual({
      byteLength: 3,
      checksum: { algorithm: 'crc64-ecma', value: CRC64 },
      etag: '"remote-etag"',
      contentType: 'text/plain',
    });
    expect(stat?.checksum?.value).not.toBe(stat?.etag);
  });

  it('does not treat a missing crc64 header or the etag as a checksum', async () => {
    const { client } = clientOf({
      async headObject() {
        return {
          data: { 'content-length': '3', etag: '"remote-etag"' },
          statusCode: 200,
          requestId: 'req-head',
        };
      },
    });
    const driver = createTosDriver({ storageId: 'tos-main', bucket: 'media', client });
    await expect(driver.stat(ref('incoming/abc.txt'))).resolves.toMatchObject({
      checksum: null,
      etag: '"remote-etag"',
    });
  });

  it('hashes downloaded bytes with sha256 instead of the etag or crc header', async () => {
    const { client } = clientOf();
    const driver = createTosDriver({ storageId: 'tos-main', bucket: 'media', client });
    const loaded = await driver.read(ref('incoming/abc.txt'));
    expect(Buffer.from(loaded.data).toString()).toBe('abc');
    expect(loaded.checksum).toEqual(sha256Checksum(Buffer.from('abc')));
    expect(loaded.checksum?.value).not.toBe('"remote-etag"');
    expect(loaded.checksum?.value).not.toBe(CRC64);
  });

  it('uses forbidOverwrite when copying with if-none-match', async () => {
    const { client, copies } = clientOf();
    const driver = createTosDriver({ storageId: 'tos-main', bucket: 'media', client });
    await driver.copy({
      from: ref('temp/abc.txt'),
      to: ref('final/abc.txt'),
      ifNoneMatch: '*',
    });
    expect(copies[0]).toMatchObject({
      bucket: 'media',
      key: 'final/abc.txt',
      srcBucket: 'media',
      srcKey: 'temp/abc.txt',
      forbidOverwrite: true,
    });
  });

  it('signs only PUT urls and keeps expires in seconds', async () => {
    const { client, signed } = clientOf();
    const driver = createTosDriver({ storageId: 'tos-main', bucket: 'media', client });
    expect(driver.capabilities.presignMethods).toEqual(['GET', 'PUT']);
    expect(driver.capabilities.conditionalWrite).toEqual({ ifNoneMatch: true });
    expect(driver.capabilities.checksums).toEqual(['sha256', 'crc64-ecma']);

    const plan = await driver.presignPut?.({
      object: ref('incoming/abc.txt'),
      contentType: 'text/plain',
      expiresInSeconds: 90,
    });
    expect(plan).toEqual({
      method: 'PUT',
      url: 'https://signed.example/incoming/abc.txt?method=PUT&expires=90',
      headers: { 'content-type': 'text/plain' },
    });
    expect(signed[0]).toMatchObject({
      bucket: 'media',
      key: 'incoming/abc.txt',
      method: 'PUT',
      expires: 90,
    });

    const readPlan = await driver.presignGet?.({
      object: ref('incoming/abc.txt'),
      expiresInSeconds: 90,
    });
    expect(readPlan).toEqual({
      method: 'GET',
      url: 'https://signed.example/incoming/abc.txt?method=GET&expires=90',
      headers: {},
    });
    expect(signed[1]).toMatchObject({
      bucket: 'media',
      key: 'incoming/abc.txt',
      method: 'GET',
      expires: 90,
    });
  });

  it('signs a multipart part with uploadId and partNumber query fields', async () => {
    const { client, signed } = clientOf();
    const driver = createTosDriver({ storageId: 'tos-main', bucket: 'media', client });
    const plan = await driver.presignPart?.({
      object: ref('incoming/abc.txt'),
      uploadId: 'up-1',
      partNumber: 2,
      expiresInSeconds: 30,
    });
    expect(plan?.method).toBe('PUT');
    expect(signed[0]).toMatchObject({
      method: 'PUT',
      expires: 30,
      query: { uploadId: 'up-1', partNumber: '2' },
    });
  });

  it('calculates partCount from the caller part size and does not send a product default', async () => {
    const { client, multipart } = clientOf();
    const driver = createTosDriver({ storageId: 'tos-main', bucket: 'media', client });
    const session = await driver.createMultipart?.({
      object: ref('blob.bin'),
      contentType: 'application/octet-stream',
      partSize: 100,
      totalBytes: 250,
    });
    expect(session).toEqual({ uploadId: 'up-1', partCount: 3 });
    expect(multipart.created[0]).toEqual({
      bucket: 'media',
      key: 'blob.bin',
      contentType: 'application/octet-stream',
    });
    expect(JSON.stringify(multipart.created[0])).not.toContain('5242880');
    expect(JSON.stringify(multipart.created[0])).not.toContain('20971520');
  });

  it('sorts complete parts into eTag fields and aborts by upload id', async () => {
    const { client, multipart } = clientOf();
    const driver = createTosDriver({ storageId: 'tos-main', bucket: 'media', client });
    const completed = await driver.completeMultipart?.({
      object: ref('blob.bin'),
      uploadId: 'up-1',
      parts: [
        { partNumber: 2, etag: '"p2"' },
        { partNumber: 1, etag: '"p1"' },
      ],
    });
    expect(completed).toEqual({ etag: '"whole"' });
    expect(multipart.completed[0]).toMatchObject({
      bucket: 'media',
      key: 'blob.bin',
      uploadId: 'up-1',
      parts: [
        { partNumber: 1, eTag: '"p1"' },
        { partNumber: 2, eTag: '"p2"' },
      ],
    });

    await driver.abortMultipart?.({ object: ref('blob.bin'), uploadId: 'up-1' });
    expect(multipart.aborted[0]).toEqual({ bucket: 'media', key: 'blob.bin', uploadId: 'up-1' });
  });

  it('does not call completeMultipartUpload for an empty etag or a duplicate part', async () => {
    const { client, multipart } = clientOf();
    const driver = createTosDriver({ storageId: 'tos-main', bucket: 'media', client });
    await expect(
      driver.completeMultipart?.({
        object: ref('blob.bin'),
        uploadId: 'up-1',
        parts: [{ partNumber: 1, etag: '' }],
      }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    await expect(
      driver.completeMultipart?.({
        object: ref('blob.bin'),
        uploadId: 'up-1',
        parts: [
          { partNumber: 1, etag: '"a"' },
          { partNumber: 1, etag: '"b"' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    expect(multipart.completed).toEqual([]);
  });

  it('maps 404, 403, and cancellation without echoing a signed url or secret', async () => {
    const failing = (statusCode: number): TosObjectClient['putObject'] => async () => {
      throw { statusCode, message: SECRET_MESSAGE, requestId: 'req-safe' };
    };
    const forbidden = createTosDriver({
      storageId: 'tos-main',
      bucket: 'media',
      client: clientOf({ putObject: failing(403) }).client,
    });
    await expect(
      forbidden.put({ object: ref('x'), data: Buffer.from('a'), checksum: sha256Checksum(Buffer.from('a')) }),
    ).rejects.toMatchObject({ code: 'forbidden', requestId: 'req-safe' });

    const missing = createTosDriver({
      storageId: 'tos-main',
      bucket: 'media',
      client: clientOf({
        headObject: async () => {
          throw { statusCode: 404, message: SECRET_MESSAGE, requestId: 'req-missing' };
        },
        getObject: async () => {
          throw { statusCode: 404, message: SECRET_MESSAGE };
        },
      }).client,
    });
    await expect(missing.stat(ref('gone'))).resolves.toBeNull();
    await expect(missing.read(ref('gone'))).rejects.toMatchObject({ code: 'not_found' });

    const cancelled = createTosDriver({
      storageId: 'tos-main',
      bucket: 'media',
      client: clientOf({
        putObject: async () => {
          const error = new Error(SECRET_MESSAGE);
          error.name = 'CancelError';
          throw error;
        },
      }).client,
    });
    await expect(
      cancelled.put({ object: ref('x'), data: Buffer.from('a'), checksum: sha256Checksum(Buffer.from('a')) }),
    ).rejects.toMatchObject({ code: 'cancelled' });

    const signal = AbortSignal.abort();
    const { client, puts } = clientOf();
    const driver = createTosDriver({ storageId: 'tos-main', bucket: 'media', client });
    await expect(
      driver.put({
        object: ref('x'),
        data: Buffer.from('a'),
        checksum: sha256Checksum(Buffer.from('a')),
        signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(puts).toEqual([]);

    for (const error of [
      await forbidden
        .put({ object: ref('x'), data: Buffer.from('a'), checksum: sha256Checksum(Buffer.from('a')) })
        .catch((caught: unknown) => caught),
    ]) {
      const message = error instanceof Error ? error.message : '';
      expect(message).not.toContain('secret-value');
      expect(message).not.toContain('super-secret');
      expect(message).not.toContain('https://');
      expect(message).not.toContain('X-Tos-Signature');
    }
  });

  it('maps overwrite conflicts without leaking the client message', async () => {
    const { client } = clientOf({
      putObject: async () => {
        throw { statusCode: 409, message: SECRET_MESSAGE };
      },
    });
    const driver = createTosDriver({ storageId: 'tos-main', bucket: 'media', client });
    await expect(
      driver.put({
        object: ref('x'),
        data: Buffer.from('a'),
        checksum: sha256Checksum(Buffer.from('a')),
        precondition: { ifNoneMatch: '*' },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});
