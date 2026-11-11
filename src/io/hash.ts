import { createHash } from 'node:crypto';
import type { Checksum } from '../core/contracts.js';

export function sha256Checksum(data: Uint8Array): Checksum {
  return {
    algorithm: 'sha256',
    value: createHash('sha256').update(data).digest('hex'),
  };
}
