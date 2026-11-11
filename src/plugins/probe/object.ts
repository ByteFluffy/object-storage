import type { Checksum, ObjectRef, ObjectStat, StorageDriver } from '../../core/contracts.js';
import type { ProbeResult } from '../../core/plugin.js';
import { resultFromDriverError } from './driver-error.js';

export async function checkObject(
  driver: StorageDriver,
  input: Readonly<{
    ref: ObjectRef;
    expectedChecksum?: Checksum;
    expectedByteLength?: number;
  }>,
): Promise<ProbeResult> {
  const checkedAt = new Date().toISOString();
  try {
    const stat = await driver.stat(input.ref);
    if (!stat) return { status: 'not_found', checkedAt };
    return compareStat(stat, input, checkedAt);
  } catch (error) {
    return resultFromDriverError(error, checkedAt);
  }
}

function compareStat(
  stat: ObjectStat,
  input: Readonly<{ expectedChecksum?: Checksum; expectedByteLength?: number }>,
  checkedAt: string,
): ProbeResult {
  const checksum = stat.checksum ?? undefined;
  const withChecksum = checksum === undefined ? {} : { checksum };

  if (input.expectedChecksum) {
    const sameChecksum =
      checksum !== undefined &&
      checksum.algorithm === input.expectedChecksum.algorithm &&
      checksum.value === input.expectedChecksum.value;
    if (!sameChecksum || (input.expectedByteLength !== undefined && input.expectedByteLength !== stat.byteLength)) {
      return {
        status: 'mismatch',
        checkedAt,
        byteLength: stat.byteLength,
        ...withChecksum,
        code: checksum === undefined ? 'checksum_unavailable' : 'checksum_mismatch',
      };
    }
    return { status: 'passed', checkedAt, byteLength: stat.byteLength, checksum };
  }

  if (input.expectedByteLength !== undefined) {
    // Length can match while the bytes differ, so this cannot be passed.
    return {
      status: 'mismatch',
      checkedAt,
      byteLength: stat.byteLength,
      ...withChecksum,
      code: input.expectedByteLength === stat.byteLength ? 'checksum_unavailable' : 'checksum_mismatch',
    };
  }

  return { status: 'passed', checkedAt, byteLength: stat.byteLength, ...withChecksum };
}
