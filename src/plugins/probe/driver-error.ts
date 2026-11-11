import type { ProbeResult, ProbeStatus } from '../../core/plugin.js';
import { StorageError } from '../../core/errors.js';

export function resultFromDriverError(error: unknown, checkedAt: string): ProbeResult {
  if (!(error instanceof StorageError)) throw error;
  if (error.code === 'cancelled' || error.code === 'config_invalid' || error.code === 'config_missing') {
    throw error;
  }
  return {
    status: statusFor(error.code),
    checkedAt,
    code: error.code,
  };
}

function statusFor(code: StorageError['code']): ProbeStatus {
  if (code === 'forbidden') return 'forbidden';
  if (code === 'not_found') return 'not_found';
  if (code === 'checksum_mismatch') return 'mismatch';
  return 'unavailable';
}
