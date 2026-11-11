import { describe, expect, it } from 'vitest';
import { mergeConfig } from '../../src/core/config.js';
import { StorageError } from '../../src/core/errors.js';

describe('mergeConfig', () => {
  it('uses the operation value when the field is present', () => {
    const merged = mergeConfig(
      { maxInputBytes: 10, contentType: 'application/octet-stream' },
      { maxInputBytes: 4 },
      ['maxInputBytes', 'contentType'],
    );

    expect(merged).toEqual({ maxInputBytes: 4, contentType: 'application/octet-stream' });
  });

  it('rejects an unknown operation field before merging', () => {
    expect(() =>
      mergeConfig({ maxInputBytes: 10 }, { region: 'cn-beijing' }, ['maxInputBytes']),
    ).toThrow(StorageError);

    try {
      mergeConfig({ maxInputBytes: 10 }, { region: 'cn-beijing' }, ['maxInputBytes']);
    } catch (error) {
      expect(error).toMatchObject({ code: 'config_invalid', retryable: false });
    }
  });

  it('does not deep-merge nested values', () => {
    expect(() =>
      mergeConfig({ maxInputBytes: 10 }, { maxInputBytes: { nested: true } }, ['maxInputBytes']),
    ).toThrow(StorageError);
  });
});
