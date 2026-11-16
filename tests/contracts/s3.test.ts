import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { sha256Checksum } from '../../src/io/hash.js';
import { StorageError } from '../../src/core/errors.js';
import { bindS3Client, createS3Client, createS3Driver, createS3Storage, type S3ObjectClient } from '../../src/drivers/s3.js';
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
  afterEach(() => vi.restoreAllMocks());
  it('binds direct PUT write defaults into real signed headers and returns those required headers', async () => {
    const writeDefaults = { acl: 'public-read' as const, cacheControl: 'public, max-age=60' };
    const { client, signed } = clientOf(async () => { throw new Error('No upload request is expected'); });
    const driver = createS3Driver({ storageId: 's3-main', bucket: 'media', client, writeDefaults });
    const input = { object: ref('direct.txt'), contentType: 'text/plain', expiresInSeconds: 60 };
    const plan = await driver.presignPut!(input);
    expect((signed[0]!.command as PutObjectCommand).input).toMatchObject({ ACL: writeDefaults.acl, CacheControl: writeDefaults.cacheControl });
    expect(plan.headers).toEqual({ 'content-type': 'text/plain', 'x-amz-acl': writeDefaults.acl, 'cache-control': writeDefaults.cacheControl });
    const owned = createS3Storage({ storageId: 's3-main', bucket: 'media', endpoint: 'https://s3.example',
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' }, writeDefaults });
    try {
      const actual = await owned.driver.presignPut!(input);
      const url = new URL(actual.url);
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('cache-control;host;x-amz-acl');
      expect(url.searchParams.has('x-amz-acl')).toBe(false);
      expect(actual.headers).toEqual(plan.headers);
    } finally { owned.close(); }
  });
  it('applies one connection write policy to both single PUT and multipart creation', async () => {
    const commands: object[] = [];
    vi.spyOn(S3Client.prototype, 'send').mockImplementation(async command => {
      commands.push(command);
      return command instanceof CreateMultipartUploadCommand ? { UploadId: 'up-1', $metadata: {} } : { ETag: '"part"', $metadata: {} };
    });
    const owned = createS3Storage({ storageId: 's3-main', bucket: 'media', endpoint: 'https://s3.example',
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
      writeDefaults: { acl: 'public-read', cacheControl: 'public, max-age=31536000, immutable' } });
    try {
      const input = { storageId: 's3-main', contentType: 'text/plain', source: { kind: 'bytes' as const, data: new Uint8Array([1, 2, 3]) } };
      await owned.storage.upload({ ...input, key: 'single.txt' });
      await owned.storage.upload({ ...input, key: 'multipart.txt', multipart: 'required',
        multipartOptions: { thresholdBytes: 5 * 1024 * 1024, partSizeBytes: 5 * 1024 * 1024 } });
      const put = commands.find(command => command instanceof PutObjectCommand) as PutObjectCommand;
      const created = commands.find(command => command instanceof CreateMultipartUploadCommand) as CreateMultipartUploadCommand;
      for (const command of [put, created]) expect(command.input).toMatchObject({
        ACL: 'public-read', CacheControl: 'public, max-age=31536000, immutable', ContentType: 'text/plain',
      });
    } finally { owned.close(); }
  });
  it('cancels the installed SDK GetObject response stream after headers without an HTTP request', async () => {
    const raw = new Readable({ read() {} });
    const closed = new Promise<void>(resolve => raw.once('close', resolve));
    const sdk = createS3Client({ region: 'us-east-1', endpoint: 'https://s3.example', maxAttempts: 1,
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
      requestHandler: { handle: async () => ({ response: { statusCode: 200,
        headers: { 'content-length': '10', 'content-type': 'video/mp4' }, body: raw } }) },
    });
    try {
      const driver = createS3Driver({ storageId: 's3-main', bucket: 'media', client: bindS3Client(sdk) });
      const controller = new AbortController();
      const opened = await driver.openRead!(ref('stall.bin'), { signal: controller.signal });
      expect(opened).toMatchObject({ byteLength: 10, contentType: 'video/mp4' });
      const reader = opened.body.getReader(); const reading = reader.read(); controller.abort();
      await expect(reading).rejects.toMatchObject({ code: 'cancelled' });
      await closed; expect(raw.destroyed).toBe(true); reader.releaseLock();
    } finally { sdk.destroy(); }
  });
  it('presigns the real multipart abort command as DELETE with its original upload identity', async () => {
    const { client, signed } = clientOf(async () => { throw new Error('No object request is expected'); });
    const driver = createS3Driver({ storageId: 's3-main', bucket: 'media', client });
    await expect(driver.presignAbortMultipart!({ object: ref('stream.bin'), uploadId: 'up-1', expiresInSeconds: 60 }))
      .resolves.toMatchObject({ method: 'DELETE', headers: {} });
    expect(signed[0]!.command).toBeInstanceOf(AbortMultipartUploadCommand);
    expect((signed[0]!.command as AbortMultipartUploadCommand).input).toEqual({ Bucket: 'media', Key: 'stream.bin', UploadId: 'up-1' });
    expect(signed[0]!.options.expiresIn).toBe(60);
    const owned = createS3Storage({ storageId: 's3-main', bucket: 'media', endpoint: 'https://s3.example',
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } });
    try {
      const actual = await owned.driver.presignAbortMultipart!({ object: ref('stream.bin'), uploadId: 'up-1', expiresInSeconds: 60 });
      const url = new URL(actual.url);
      expect(actual.method).toBe('DELETE'); expect(url.searchParams.get('uploadId')).toBe('up-1');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('60'); expect(url.searchParams.has('X-Amz-Signature')).toBe(true);
    } finally { owned.close(); }
  });
  it('opens a lazy SDK stream and reads bounded bytes with truthful content metadata', async () => {
    let pulled = 0;
    const signal = new AbortController().signal;
    const { client } = clientOf(async (_command, options) => {
      expect(options?.abortSignal).toBe(signal);
      return { ContentLength: 3, ContentType: 'image/png', Body: { transformToWebStream: () => new ReadableStream<Uint8Array>({
        pull(controller) { pulled++; controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); },
      }, { highWaterMark: 0 }) } };
    });
    const driver = createS3Driver({ storageId: 's3-main', bucket: 'media', client });
    const opened = await driver.openRead!(ref('image.png'), { signal, maxBytes: 3 });
    expect(pulled).toBe(0); expect(opened).toMatchObject({ byteLength: 3, contentType: 'image/png' });
    expect(new Uint8Array(await new Response(opened.body).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    const read = await driver.read(ref('image.png'), { signal, maxBytes: 3 });
    expect(read).toMatchObject({ data: new Uint8Array([1, 2, 3]), checksum: sha256Checksum(new Uint8Array([1, 2, 3])), contentType: 'image/png' });
  });

  it('actively cancels an SDK body stalled after headers and releases the owned reader', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const raw = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const { client } = clientOf(async () => ({ ContentLength: 10, Body: { transformToWebStream: () => raw } }));
    const driver = createS3Driver({ storageId: 's3-main', bucket: 'media', client });
    const opened = await driver.openRead!(ref('stall.bin'), { signal: controller.signal });
    const reader = opened.body.getReader();
    const reading = reader.read(); controller.abort();
    await expect(reading).rejects.toMatchObject({ code: 'cancelled' });
    expect(cancel).toHaveBeenCalledOnce(); expect(raw.locked).toBe(false); reader.releaseLock();
  });

  it.each([{ declared: 4, bytes: 3, maxBytes: 4 }, { declared: 3, bytes: 3, maxBytes: 2 }])(
    'rejects incorrect or excessive SDK content before returning a buffered read: %j', async ({ declared, bytes, maxBytes }) => {
      let opened = false;
      const { client } = clientOf(async () => ({ ContentLength: declared, Body: { transformToWebStream: () => { opened = true; return new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); },
      }); } } }));
      const driver = createS3Driver({ storageId: 's3-main', bucket: 'media', client });
      await expect(driver.read(ref('bad.bin'), { maxBytes })).rejects.toBeInstanceOf(StorageError);
      expect(opened).toBe(true);
    },
  );

  it('preserves operation cancellation for stat and delete without swallowing non-404 errors', async () => {
    const signal = new AbortController().signal;
    const { client } = clientOf(async (_command, options) => { expect(options?.abortSignal).toBe(signal); return { ContentLength: 3 }; });
    const driver = createS3Driver({ storageId: 's3-main', bucket: 'media', client });
    await expect(driver.stat(ref('object.bin'), { signal })).resolves.toMatchObject({ byteLength: 3 });
    await driver.delete(ref('object.bin'), { signal });
    for (const failure of [{ $metadata: { httpStatusCode: 403 } }, new Error('network failed')]) {
      const denied = createS3Driver({ storageId: 's3-main', bucket: 'media', client: clientOf(async () => { throw failure; }).client });
      await expect(denied.stat(ref('object.bin'), { signal })).rejects.toBeInstanceOf(StorageError);
      await expect(denied.delete(ref('object.bin'), { signal })).rejects.toBeInstanceOf(StorageError);
    }
  });
  it('owns one reusable Storage client with required-only checksum defaults and closes it once', async () => {
    const destroyed = vi.spyOn(S3Client.prototype, 'destroy');
    const sent = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async function (this: S3Client) {
      expect(await this.config.requestChecksumCalculation()).toBe('WHEN_REQUIRED');
      expect(await this.config.responseChecksumValidation()).toBe('WHEN_REQUIRED');
      expect(await this.config.region()).toBe('us-east-1');
      return { ETag: '"stored"', $metadata: {} };
    });
    const owned = createS3Storage({ storageId: 's3-main', bucket: 'media', endpoint: 'https://s3.example',
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } });
    try {
      const result = await owned.storage.upload({ storageId: 's3-main', key: 'owned.bin', source: { kind: 'bytes', data: new Uint8Array([1, 2, 3]) } });
      expect(result).toMatchObject({ byteLength: 3, checksum: sha256Checksum(new Uint8Array([1, 2, 3])), etag: '"stored"' });
      expect(owned.driver.storageId).toBe('s3-main'); expect(sent).toHaveBeenCalledOnce();
      owned.close(); owned.close(); expect(destroyed).toHaveBeenCalledOnce();
    } finally { owned.close(); sent.mockRestore(); destroyed.mockRestore(); }
  });

  it('uses the configured SDK endpoint, region, session token and path style for signed reads', async () => {
    const owned = createS3Storage({ storageId: 's3-main', bucket: 'media', endpoint: 'https://s3.example',
      region: 'ap-southeast-1', forcePathStyle: true,
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture', sessionToken: 'fixture-session' } });
    try {
      const plan = await owned.driver.presignGet!({ object: ref('a b.bin'), expiresInSeconds: 60 });
      const url = new URL(plan.url);
      expect(url.host).toBe('s3.example'); expect(url.pathname).toBe('/media/a%20b.bin');
      expect(url.searchParams.get('X-Amz-Credential')).toContain('/ap-southeast-1/s3/aws4_request');
      expect(url.searchParams.get('X-Amz-Security-Token')).toBe('fixture-session');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
    } finally { owned.close(); }
  });

  it('serializes multipart bytes and conditional completion through the installed SDK without network I/O', async () => {
    const wire: { method: string; headers: Record<string, string>; body?: unknown }[] = [];
    const sdk = createS3Client({ region: 'us-east-1', endpoint: 'https://s3.example',
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' }, maxAttempts: 1,
      requestHandler: { handle: async (request: typeof wire[number]) => {
        wire.push(request);
        const body = request.method === 'POST'
          ? new TextEncoder().encode('<CompleteMultipartUploadResult><ETag>"sdk-whole"</ETag></CompleteMultipartUploadResult>') : new Uint8Array();
        return { response: { statusCode: 200, headers: { etag: '"sdk-part"' }, body } };
      } },
    });
    try {
      const driver = createS3Driver({ storageId: 's3-main', bucket: 'media', client: bindS3Client(sdk) });
      const part = await driver.uploadPart!({ object: ref('stream.bin'), uploadId: 'up-1', partNumber: 1, data: new Uint8Array([1, 2, 3]) });
      expect(part.etag).toBe('"sdk-part"');
      expect(wire[0]!.method).toBe('PUT'); expect(wire[0]!.headers['content-length']).toBe('3');
      await driver.completeMultipart!({ object: ref('stream.bin'), uploadId: 'up-1', parts: [{ partNumber: 1, etag: part.etag }], precondition: { ifNoneMatch: '*' } });
      expect(wire[1]!.method).toBe('POST'); expect(wire[1]!.headers['if-none-match']).toBe('*');
    } finally { sdk.destroy(); }
  });

  it('creates an unknown-length multipart session without inventing a part count', async () => {
    const signal = new AbortController().signal;
    const sent: { command: object; options: unknown }[] = [];
    const { client } = clientOf(async (command, options) => {
      sent.push({ command, options });
      return { UploadId: 'stream-1' };
    });
    const driver = createS3Driver({ storageId: 's3-main', bucket: 'media', client });
    await expect(driver.createMultipart!({ object: ref('stream.bin'), partSize: 8 * 1024 * 1024, signal }))
      .resolves.toEqual({ uploadId: 'stream-1' });
    expect(sent[0]!.command).toBeInstanceOf(CreateMultipartUploadCommand);
    expect(sent[0]!.options).toEqual({ abortSignal: signal });
  });

  it('uploads one server-side part as the exact bounded bytes with cancellation', async () => {
    const data = new Uint8Array([0, 1, 2, 255]);
    const signal = new AbortController().signal;
    const sent: { command: object; options: unknown }[] = [];
    const { client } = clientOf(async (command, options) => {
      sent.push({ command, options }); return { ETag: '"part-2"' };
    });
    const driver = createS3Driver({ storageId: 's3-main', bucket: 'media', client });
    await expect(driver.uploadPart!({ object: ref('stream.bin'), uploadId: 'stream-1', partNumber: 2, data, signal }))
      .resolves.toEqual({ etag: '"part-2"' });
    expect(sent[0]!.command).toBeInstanceOf(UploadPartCommand);
    expect((sent[0]!.command as UploadPartCommand).input).toEqual({ Bucket: 'media', Key: 'stream.bin',
      UploadId: 'stream-1', PartNumber: 2, Body: data, ContentLength: 4 });
    expect(sent[0]!.options).toEqual({ abortSignal: signal });
  });

  it.each([undefined, ''])('rejects a part response without a usable ETag: %s', async ETag => {
    const driver = createS3Driver({ storageId: 's3-main', bucket: 'media', client: clientOf(async () => ({ ETag })).client });
    await expect(driver.uploadPart!({ object: ref('stream.bin'), uploadId: 'stream-1', partNumber: 1, data: new Uint8Array([1]) }))
      .rejects.toMatchObject({ code: 'unavailable' });
  });

  it('completes with the actual conditional-write field and keeps cleanup cancellation independent', async () => {
    const sent: { command: object; options: unknown }[] = [];
    const { client } = clientOf(async (command, options) => { sent.push({ command, options }); return { ETag: '"whole"' }; });
    const driver = createS3Driver({ storageId: 's3-main', bucket: 'media', client });
    const signal = new AbortController().signal;
    await expect(driver.completeMultipart!({ object: ref('stream.bin'), uploadId: 'stream-1',
      parts: [{ partNumber: 1, etag: '"part"' }], precondition: { ifNoneMatch: '*' }, signal }))
      .resolves.toEqual({ etag: '"whole"' });
    expect((sent[0]!.command as CompleteMultipartUploadCommand).input.IfNoneMatch).toBe('*');
    expect(sent[0]!.options).toEqual({ abortSignal: signal });
    const cleanupSignal = new AbortController().signal;
    await driver.abortMultipart!({ object: ref('stream.bin'), uploadId: 'stream-1', signal: cleanupSignal });
    expect(sent[1]!.command).toBeInstanceOf(AbortMultipartUploadCommand);
    expect(sent[1]!.options).toEqual({ abortSignal: cleanupSignal });
  });

  it('keeps a successful creation receipt when the caller cancels during independent admission', async () => {
    const caller = new AbortController();
    const admission = new AbortController();
    const { client } = clientOf(async () => { caller.abort(); return { UploadId: 'created-before-cancel' }; });
    const driver = createS3Driver({ storageId: 's3-main', bucket: 'media', client });
    await expect(driver.createMultipart!({ object: ref('stream.bin'), partSize: 8 * 1024 * 1024, signal: admission.signal }))
      .resolves.toEqual({ uploadId: 'created-before-cancel' });
    expect(caller.signal.aborted).toBe(true);
  });

  it('actively rejects a cancelled in-flight part with a sanitized storage error', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const admitted = new Promise<void>(resolve => { started = resolve; });
    const { client } = clientOf((_command, options) => new Promise((_resolve, reject) => {
      options!.abortSignal!.addEventListener('abort', () => reject(Object.assign(new Error(SECRET_MESSAGE), { name: 'AbortError' })), { once: true });
      started();
    }));
    const driver = createS3Driver({ storageId: 's3-main', bucket: 'media', client });
    const uploading = driver.uploadPart!({ object: ref('stream.bin'), uploadId: 'stream-1', partNumber: 1,
      data: new Uint8Array([1]), signal: controller.signal });
    await admitted; controller.abort();
    await expect(uploading).rejects.toMatchObject({ code: 'cancelled', message: 'operation cancelled' });
  });

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
    expect(driver.capabilities.presignMethods).toEqual(['GET', 'PUT', 'HEAD', 'DELETE']);
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
          Body: { transformToWebStream: () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('abc')); controller.close(); } }) },
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
