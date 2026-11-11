import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('optional image entry', () => {
  it('does not reference the image plugin or sharp from the package root', () => {
    const source = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('plugins/image');
    expect(source).not.toContain('sharp');
  });
});
