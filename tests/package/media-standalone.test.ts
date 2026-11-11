import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('media plugin stays out of the package root', () => {
  it('does not mention the media plugin, ffmpeg, or child_process', () => {
    const root = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
    expect(root).not.toMatch(/plugins\/media/);
    expect(root).not.toMatch(/ffmpeg/);
    expect(root).not.toMatch(/child_process/);
  });
});
