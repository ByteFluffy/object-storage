import { describe, expect, it } from 'vitest';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { sha256Checksum } from '../../src/io/hash.js';
import { bindS3Client, createS3Client, createS3Driver, type S3ObjectClient } from '../../src/drivers/s3.js';
import type { ObjectRef } from '../../src/core/contracts.js';

const SECRET_MESSAGE =
  'https://bucket.s3.amazonaws.com/obj?X-Amz-Signature=secret-value accessKeySecret=super-secret';

function ref(key: string): ObjectRef {
  return { storageId: 's3-main', key };
}

function clientOf(send: S3ObjectClient['send'], presign?: S3ObjectClient['presign']): {
  client: S3ObjectClient;
  signed: { command: object; options: { expiresIn: number } }[];
} {
  const signed: { command: object; options: { expiresIn: number } }[] = [];
  return {
    signed,
    client: {
      send,
      presign: presign ?? (async (command, options) => {
        signed.push({ command, options });
        const input = (command as { input?: { Key?: string } }).input;
        return `https://signed.example/${input?.Key ?? ''}?expires=${options.expiresIn}`;
      }),
    },
  };
}

describe('S3 driver', () => {
  it('exposes the real client helpers without calling them', () => {
    expect(typeof createS3Client).toBe('function');
    expect(typeof bindS3Client).toBe('function');
  });

  it('sends PutObject with IfNoneMatch because that field exists on this SDK', async () => {
    const sent: object[] = [];
    const { client } = clientOf(async (command) => {
      sent.push(command);
      return { ETag: '"s3-etag"', ChecksumSHA256: 'base64-not-hex', ChecksumCRC64NVME: 'nvme' };
    });
    const driver = createS3Driver({ storageId: 's3-main', bucket: 'media', client });
    const data = Buffer.from('abc');
    const written = await driver.put({
      object: ref('incoming/abc.txt'),
      data,
      contentType: 'text/plain',
      checksum: sha256Checksum(data),
      precondition: { ifNoneMatch: '*' },
    });

    expect(driver.capabilities.conditionalWrite).toEqual({ ifNoneMatch: true });
    expect(driver.capabilities.presignMethods).toEqual(['GET', 'PUT', 'HEAD']);
    expect(driver.capabilities.checksums).toEqual(['sha256']);
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect((sent[0] as PutObjectCommand).input).toMatchObject({
      Bucket: 'media',
      Key: 'incoming/abc.txt',
      ContentType: 'text/plain',
      IfNoneMatch: '*',
    });
    expect(Buffer.from((sent[0] as PutObjectCommand).input.Body as Uint8Array).equals(data)).toBe(true);
    expect(written.etag).toBe('"s3-etag"');
    expect(written.checksum).toEqual(sha256Checksum(data));
    expect(written.checksum?.value).not.toBe(written.etag);
    expect(written.checksum?.value).not.toBe('base64-not-hex');
    expect(written.checksum?.value).not.toBe('nvme');
  });

  it('omits IfNoneMatch when the caller does not ask for it', async () => {
    const sent: PutObjectCommand[] = [];
    const { client } = clientOf(async (command) => {
      sent.push(command as PutObjectCommand);
      return { ETag: '"s3-etag"' };
    });
    const driver = createS3Driver({ storageId: 's3-main', bucket: 'media', client });
    await driver.put({
      object: ref('plain.txt'),
      data: Buffer.from('abc'),
      checksum: sha256Checksum(Buffer.from('abc')),
    });
    expect(sent[0]?.input.IfNoneMatch).toBeUndefined();
  });

  it('does not use the etag or CRC64NVME header as a crc64-ecma checksum', async () => {
    const { client } = clientOf(async (command) => {
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: 3,
          ETag: '"s3-etag"',
          ContentType: 'text/plain',
          ChecksumCRC64NVME: '18446744073709551615',
          ChecksumSHA256: 'base64-not-hex',
        };
      }
      if (command instanceof GetObjectCommand) {
        return {
          Body: { transformToByteArray: async () => Buffer.from('abc') },
          ETag: '"s3-etag"',
          ContentLength: 3,
        };
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    });
    const driver = createS3Driver({ storageId: 's3-main', bucket: 'media', client });
    await expect(driver.stat(ref('incoming/abc.txt'))).resolves.toEqual({
      byteLength: 3,
      checksum: null,
      etag: '"s3-etag"',
      contentType: 'text/plain',
    });
    const loaded = await driver.read(ref('incoming/abc.txt'));
    expect(loaded.checksum).toEqual(sha256Checksum(Buffer.from('abc')));
    expect(loaded.checksum?.value).not.toBe('"s3-etag"');
  });

  it('copies with destination IfNoneMatch and passes the abort signal to send', async () => {
    const calls: { command: object; options: unknown }[] = [];
    const signal = new AbortController().signal;
    const { client } = clientOf(async (command, options) => {
      calls.push({ command, options });
      if (command instanceof CopyObjectCommand) return {};
      if (command instanceof HeadObjectCommand) return { ContentLength: 1, ETag: '"e"' };
      return {};
    });
    const driver = createS3Driver({ storageId: 's3-main', bucket: 'media', client });
    await driver.copy({ from: ref('temp/a b.txt'), to: ref('final/a b.txt'), ifNoneMatch: '*', signal });
    expect(calls[0]?.command).toBeInstanceOf(CopyObjectCommand);
    expect((calls[0]?.command as CopyObjectCommand).input).toMatchObject({
      Bucket: 'media',
      Key: 'final/a b.txt',
      CopySource: 'media/temp/a%20b.txt',
      IfNoneMatch: '*',
    });
    expect(calls[0]?.options).toEqual({ abortSignal: signal });
  });

  it('presigns PUT and part uploads through the injected presign function', async () => {
    const { client, signed } = clientOf(async () => ({}));
    const driver = createS3Driver({ storageId: 's3-main', bucket: 'media', client });
    const plan = await driver.presignPut?.({
      object: ref('incoming/abc.txt'),
      contentType: 'text/plain',
      expiresInSeconds: 90,
    });
    expect(plan).toEqual({
      method: 'PUT',
      url: 'https://signed.example/incoming/abc.txt?expires=90',
      headers: { 'content-type': 'text/plain' },
    });
    expect(signed[0]?.command).toBeInstanceOf(PutObjectCommand);
    expect((signed[0]?.command as PutObjectCommand).input).toMatchObject({
      Bucket: 'media',
      Key: 'incoming/abc.txt',
      ContentType: 'text/plain',
    });
    expect((signed[0]?.command as PutObjectCommand).input.IfNoneMatch).toBeUndefined();
    expect(signed[0]?.options).toEqual({ expiresIn: 90 });

    const readPlan = await driver.presignGet?.({
      object: ref('incoming/abc.txt'),
      expiresInSeconds: 45,
    });
    expect(readPlan).toEqual({
      method: 'GET',
      url: 'https://signed.example/incoming/abc.txt?expires=45',
      headers: {},
    });
    expect(signed[1]?.command).toBeInstanceOf(GetObjectCommand);
    expect((signed[1]?.command as GetObjectCommand).input).toMatchObject({
      Bucket: 'media',
      Key: 'incoming/abc.txt',
    });
    expect(signed[1]?.options).toEqual({ expiresIn: 45 });

    await driver.presignPart?.({
      object: ref('incoming/abc.txt'),
      uploadId: 'up-1',
      partNumber: 2,
      expiresInSeconds: 30,
    });
    expect(signed[2]?.command).toBeInstanceOf(UploadPartCommand);
    expect((signed[2]?.command as UploadPartCommand).input).toMatchObject({
      Bucket: 'media',
      Key: 'incoming/abc.txt',
      UploadId: 'up-1',
      PartNumber: 2,
    });
    expect(signed[2]?.options).toEqual({ expiresIn: 30 });
  });

  it('does not invent a multipart part size', async () => {
    const sent: CreateMultipartUploadCommand[] = [];
    const { client } = clientOf(async (command) => {
      if (command instanceof CreateMultipartUploadCommand) {
        sent.push(command);
        return { UploadId: 'up-1' };
      }
      if (command instanceof CompleteMultipartUploadCommand) return { ETag: '"whole"' };
      if (command instanceof AbortMultipartUploadCommand) return {};
      return {};
    });
    const driver = createS3Driver({ storageId: 's3-main', bucket: 'media', client });
    await expect(
      driver.createMultipart?.({
        object: ref('blob.bin'),
        contentType: 'application/octet-stream',
        partSize: 100,
        totalBytes: 250,
      }),
    ).resolves.toEqual({ uploadId: 'up-1', partCount: 3 });
    expect(sent[0]?.input).toEqual({
      Bucket: 'media',
      Key: 'blob.bin',
      ContentType: 'application/octet-stream',
    });

    await driver.completeMultipart?.({
      object: ref('blob.bin'),
      uploadId: 'up-1',
      parts: [
        { partNumber: 2, etag: '"p2"' },
        { partNumber: 1, etag: '"p1"' },
      ],
    });
    await driver.abortMultipart?.({ object: ref('blob.bin'), uploadId: 'up-1' });
  });

  it('sorts completed parts and skips the client when an etag is empty', async () => {
    const sent: CompleteMultipartUploadCommand[] = [];
    const { client } = clientOf(async (command) => {
      if (command instanceof CompleteMultipartUploadCommand) sent.push(command);
      return { ETag: '"whole"' };
    });
    const driver = createS3Driver({ storageId: 's3-main', bucket: 'media', client });
    await driver.completeMultipart?.({
      object: ref('blob.bin'),
      uploadId: 'up-1',
      parts: [
        { partNumber: 2, etag: '"p2"' },
        { partNumber: 1, etag: '"p1"' },
      ],
    });
    expect(sent[0]?.input.MultipartUpload).toEqual({
      Parts: [
        { ETag: '"p1"', PartNumber: 1 },
        { ETag: '"p2"', PartNumber: 2 },
      ],
    });
    await expect(
      driver.completeMultipart?.({
        object: ref('blob.bin'),
        uploadId: 'up-1',
        parts: [{ partNumber: 1, etag: '' }],
      }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    expect(sent).toHaveLength(1);
  });

  it('maps status, not-found head, and cancellation without secrets', async () => {
    const forbiddenSend: S3ObjectClient['send'] = async () => {
      const error = new Error(SECRET_MESSAGE) as Error & { $metadata: { httpStatusCode: number; requestId: string } };
      error.$metadata = { httpStatusCode: 403, requestId: 'req-safe' };
      throw error;
    };
    const forbidden = createS3Driver({
      storageId: 's3-main',
      bucket: 'media',
      client: clientOf(forbiddenSend).client,
    });
    const data = Buffer.from('a');
    const checksum = sha256Checksum(data);
    await expect(forbidden.put({ object: ref('x'), data, checksum })).rejects.toMatchObject({
      code: 'forbidden',
      requestId: 'req-safe',
    });
    await forbidden.put({ object: ref('x'), data, checksum }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : '';
      expect(message).not.toContain('secret-value');
      expect(message).not.toContain('super-secret');
      expect(message).not.toContain('https://');
      expect(message).not.toContain('X-Amz-Signature');
    });

    const missing = createS3Driver({
      storageId: 's3-main',
      bucket: 'media',
      client: clientOf(async (command) => {
        const error = new Error(SECRET_MESSAGE) as Error & { $metadata: { httpStatusCode: number } };
        error.name = command instanceof HeadObjectCommand ? 'NotFound' : 'NoSuchKey';
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }).client,
    });
    await expect(missing.stat(ref('gone'))).resolves.toBeNull();
    await expect(missing.read(ref('gone'))).rejects.toMatchObject({ code: 'not_found' });

    const signal = AbortSignal.abort();
    let sends = 0;
    const early = createS3Driver({
      storageId: 's3-main',
      bucket: 'media',
      client: clientOf(async () => {
        sends += 1;
        return {};
      }).client,
    });
    await expect(early.put({ object: ref('x'), data, checksum, signal })).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(sends).toBe(0);

    const aborted = createS3Driver({
      storageId: 's3-main',
      bucket: 'media',
      client: clientOf(async () => {
        const error = new Error(SECRET_MESSAGE);
        error.name = 'AbortError';
        throw error;
      }).client,
    });
    await expect(aborted.put({ object: ref('x'), data, checksum })).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('maps conditional-write 412 to conflict', async () => {
    const { client } = clientOf(async () => {
      const error = new Error(SECRET_MESSAGE) as Error & { $metadata: { httpStatusCode: number } };
      error.$metadata = { httpStatusCode: 412 };
      throw error;
    });
    const driver = createS3Driver({ storageId: 's3-main', bucket: 'media', client });
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
