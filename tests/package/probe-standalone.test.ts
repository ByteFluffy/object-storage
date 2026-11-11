import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('probe package boundary', () => {
  it('does not pull probe or cleanup plugins into the root entry', () => {
    const source = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('plugins/probe');
    expect(source).not.toContain('plugins/cleanup');
  });
});
