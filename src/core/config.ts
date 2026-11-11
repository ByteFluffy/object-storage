import type { ScalarConfig } from './contracts.js';
import { StorageError } from './errors.js';

export function mergeConfig(
  init: ScalarConfig,
  operation: Readonly<Record<string, unknown>>,
  knownKeys: readonly string[],
): ScalarConfig {
  const known = new Set(knownKeys);
  for (const key of Object.keys(operation)) {
    if (!known.has(key)) {
      throw new StorageError('config_invalid', `unknown config field: ${key}`);
    }
  }

  const merged: Record<string, string | number | boolean> = { ...init };
  for (const key of knownKeys) {
    if (!Object.prototype.hasOwnProperty.call(operation, key)) continue;
    const value = operation[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new StorageError('config_invalid', `config field must be a scalar: ${key}`);
    }
    merged[key] = value;
  }
  return merged;
}
