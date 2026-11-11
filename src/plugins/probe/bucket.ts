import type { StorageDriver } from '../../core/contracts.js';
import type { ProbeResult } from '../../core/plugin.js';
import { sha256Checksum } from '../../io/hash.js';
import { resultFromDriverError } from './driver-error.js';

const PROBE_BODY = new Uint8Array();

export async function checkBucket(
  driver: StorageDriver,
  input: Readonly<{ probeKey: string; mode: 'stat' | 'write' }>,
): Promise<ProbeResult> {
  const checkedAt = new Date().toISOString();
  const ref = { storageId: driver.storageId, key: input.probeKey };

  if (input.mode === 'stat') {
    try {
      const stat = await driver.stat(ref);
      if (!stat) return { status: 'not_found', checkedAt };
      return {
        status: 'passed',
        checkedAt,
        byteLength: stat.byteLength,
        ...(stat.checksum === null ? {} : { checksum: stat.checksum }),
      };
    } catch (error) {
      return resultFromDriverError(error, checkedAt);
    }
  }

  if (!driver.capabilities.conditionalWrite.ifNoneMatch) {
    return { status: 'unavailable', checkedAt, code: 'capability_unsupported' };
  }

  try {
    await driver.put({
      object: ref,
      data: PROBE_BODY,
      checksum: sha256Checksum(PROBE_BODY),
      precondition: { ifNoneMatch: '*' },
    });
  } catch (error) {
    return resultFromDriverError(error, checkedAt);
  }

  try {
    await driver.delete(ref);
  } catch (error) {
    return resultFromDriverError(error, checkedAt);
  }

  return { status: 'passed', checkedAt };
}
