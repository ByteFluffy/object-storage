import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createStorage } from '../../src/index.js';
import { assessDelivery } from '../../src/delivery/fit.js';
import { sha256Checksum } from '../../src/io/hash.js';
import { checkObject } from '../../src/plugins/probe/index.js';
import { cleanObjects } from '../../src/plugins/cleanup/index.js';
import { bindS3Client, createS3Client, createS3Driver } from '../../src/drivers/s3.js';
import { createSingleGetPlan, createSinglePutPlan } from '../../src/server/index.js';

const enabled = process.env.OBJECT_STORAGE_LIVE_TEST === '1';

describe.skipIf(!enabled)('live bucket', () => {
  it('uploads, signs GET and PUT, checks the object, and deletes only that prefix', async () => {
    const config = liveConfig();
    const prefix = `object-storage-smoke/${randomUUID()}/`;
    const body = new TextEncoder().encode('object-storage-live');
    const checksum = sha256Checksum(body);
    const driver = createS3Driver({
      storageId: 'live',
      bucket: config.bucket,
      client: bindS3Client(createS3Client({
        region: config.region,
        endpoint: config.endpoint,
        forcePathStyle: false,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      })),
    });
    const storage = createStorage({ drivers: [driver] });
    const tempKey = `${prefix}temp.txt`;
    const finalKey = `${prefix}final.txt`;
    const directKey = `${prefix}direct.txt`;
    const keys = [tempKey, finalKey, directKey];

    try {
      const uploaded = await storage.upload({
        storageId: 'live',
        key: tempKey,
        contentType: 'text/plain',
        source: { kind: 'bytes', data: body },
      });
      expect(uploaded.delivery).toEqual({ status: 'not_requested' });
      expect(uploaded.checksum).toEqual(checksum);
      expect(uploaded.etag).not.toBe(checksum.value);

      const sealed = await storage.finalize({
        storageId: 'live',
        tempKey,
        finalKey,
        expectedChecksum: checksum,
        maxReadBytes: body.byteLength,
      });
      expect(sealed.object.key).toBe(finalKey);
      expect(sealed.reused).toBe(false);

      const checked = await checkObject(driver, {
        ref: { storageId: 'live', key: finalKey },
        expectedChecksum: checksum,
        maxReadBytes: body.byteLength,
      });
      expect(checked.status).toBe('passed');

      const fit = assessDelivery(
        { mediaType: 'text/plain', byteLength: body.byteLength },
        { allowedMediaTypes: ['text/plain'], maxBytes: body.byteLength },
      );
      expect(fit).toEqual({ status: 'usable' });

      const readPlan = await createSingleGetPlan(driver, {
        object: { storageId: 'live', key: finalKey },
        expiresInSeconds: 60,
      });
      expect(readPlan.method).toBe('GET');
      const readResponse = await fetch(readPlan.url, { headers: readPlan.headers });
      expect(readResponse.status).toBe(200);
      expect(new Uint8Array(await readResponse.arrayBuffer())).toEqual(body);

      const putPlan = await createSinglePutPlan(driver, {
        object: { storageId: 'live', key: directKey },
        contentType: 'text/plain',
        expiresInSeconds: 60,
      });
      const putResponse = await fetch(putPlan.url, {
        method: 'PUT',
        headers: putPlan.headers,
        body,
      });
      expect(putResponse.status).toBeGreaterThanOrEqual(200);
      expect(putResponse.status).toBeLessThan(300);
      const direct = await driver.read({ storageId: 'live', key: directKey });
      expect(direct.data).toEqual(body);
    } finally {
      await cleanObjects({
        driver,
        items: keys.map((key) => ({ ref: { storageId: 'live', key }, generation: 'live' })),
        currentGeneration: (ref) => (ref.key.startsWith(prefix) ? 'live' : null),
      });
      for (const key of keys) {
        expect(await driver.stat({ storageId: 'live', key })).toBeNull();
      }
    }
  }, 60_000);
});

function liveConfig(): {
  bucket: string;
  region: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
} {
  const bucket = required('OBJECT_STORAGE_S3_BUCKET');
  const region = required('OBJECT_STORAGE_S3_REGION');
  const endpoint = required('OBJECT_STORAGE_S3_ENDPOINT');
  const accessKeyId = required('OBJECT_STORAGE_S3_ACCESS_KEY_ID');
  const secretAccessKey = required('OBJECT_STORAGE_S3_SECRET_ACCESS_KEY');
  if (!endpoint.startsWith('https://')) throw new Error('endpoint must use https');
  return { bucket, region, endpoint, accessKeyId, secretAccessKey };
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}
