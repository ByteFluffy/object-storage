import { createHash } from 'node:crypto';
import type { Checksum, ReadOptions, Source } from '../core/contracts.js';
import { openBoundedRead } from './read.js';
import { sourceStream } from './sources.js';

/** Fingerprints the bytes actually read without retaining the complete source in memory. */
export async function fingerprintSource(
  source: Source,
  options: ReadOptions = {},
): Promise<{ byteLength: number; checksum: Checksum }> {
  const declared = source.kind === 'bytes' ? source.data.byteLength
    : source.kind === 'stream' ? source.declaredByteLength : undefined;
  const managed = openBoundedRead({
    body: sourceStream(source), ...(declared === undefined ? {} : { byteLength: declared }),
  }, options);
  const reader = managed.body.getReader();
  const digest = createHash('sha256');
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      digest.update(next.value);
      byteLength += next.value.byteLength;
    }
    return { byteLength, checksum: { algorithm: 'sha256', value: digest.digest('hex') } };
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function sha256Checksum(data: Uint8Array): Checksum {
  return {
    algorithm: 'sha256',
    value: createHash('sha256').update(data).digest('hex'),
  };
}
