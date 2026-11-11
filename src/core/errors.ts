export type StorageErrorCode =
  | 'config_missing'
  | 'config_invalid'
  | 'empty_key'
  | 'capability_unsupported'
  | 'cancelled'
  | 'input_too_large'
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'checksum_mismatch'
  | 'constraint_unsatisfied'
  | 'stale_receipt'
  | 'unavailable';

const RETRYABLE: ReadonlySet<StorageErrorCode> = new Set(['unavailable']);

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly retryable: boolean;
  readonly requestId: string | undefined;

  constructor(code: StorageErrorCode, message: string, requestId?: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.requestId = requestId;
  }
}
