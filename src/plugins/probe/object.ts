import type { Checksum, ObjectRef, ObjectStat, StorageDriver } from '../../core/contracts.js';
import type { ProbeResult } from '../../core/plugin.js';
import { sha256Checksum } from '../../io/hash.js';
import { resultFromDriverError } from './driver-error.js';

export async function checkObject(
  driver: StorageDriver,
  input: Readonly<{
    ref: ObjectRef;
    expectedChecksum?: Checksum;
    expectedByteLength?: number;
    maxReadBytes?: number;
  }>,
): Promise<ProbeResult> {
  const checkedAt = new Date().toISOString();
  try {
    const stat = await driver.stat(input.ref);
    if (!stat) return { status: 'not_found', checkedAt };
    const compared = compareStat(stat, input, checkedAt);
    if (!shouldRead(compared, stat, input)) return compared;
    const loaded = await driver.read(input.ref);
    const actual = sha256Checksum(loaded.data);
    if (
      actual.value === input.expectedChecksum?.value &&
      (input.expectedByteLength === undefined || input.expectedByteLength === loaded.data.byteLength)
    ) {
      return { status: 'passed', checkedAt, byteLength: loaded.data.byteLength, checksum: actual };
    }
    return {
      status: 'mismatch',
      checkedAt,
      byteLength: loaded.data.byteLength,
      checksum: actual,
      code: 'checksum_mismatch',
    };
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
    if (input.expectedByteLength !== undefined && input.expectedByteLength !== stat.byteLength) {
      return {
        status: 'mismatch',
        checkedAt,
        byteLength: stat.byteLength,
        ...withChecksum,
        code: 'checksum_mismatch',
      };
    }
    const sameAlgorithm = checksum !== undefined && checksum.algorithm === input.expectedChecksum.algorithm;
    if (!sameAlgorithm) {
      return {
        status: 'mismatch',
        checkedAt,
        byteLength: stat.byteLength,
        ...withChecksum,
        code: 'checksum_unavailable',
      };
    }
    if (checksum.value !== input.expectedChecksum.value) {
      return {
        status: 'mismatch',
        checkedAt,
        byteLength: stat.byteLength,
        checksum,
        code: 'checksum_mismatch',
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

  return {
    status: 'mismatch',
    checkedAt,
    byteLength: stat.byteLength,
    ...withChecksum,
    code: 'checksum_unavailable',
  };
}

function shouldRead(
  compared: ProbeResult,
  stat: ObjectStat,
  input: Readonly<{ expectedChecksum?: Checksum; expectedByteLength?: number; maxReadBytes?: number }>,
): boolean {
  return (
    compared.code === 'checksum_unavailable' &&
    input.expectedChecksum?.algorithm === 'sha256' &&
    input.maxReadBytes !== undefined &&
    stat.byteLength <= input.maxReadBytes
  );
}
