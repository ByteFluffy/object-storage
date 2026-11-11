import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createStorage } from '../../dist/index.js';
import { executeDirectUpload } from '../../dist/browser/index.js';

describe('built package entries', () => {
  it('loads the server and browser entries from dist', () => {
    expect(typeof createStorage).toBe('function');
    expect(typeof executeDirectUpload).toBe('function');
  });

  it('keeps Node builtins and cloud SDKs out of the built browser entry', () => {
    const browser = readFileSync(new URL('../../dist/browser/index.js', import.meta.url), 'utf8');
    const upload = readFileSync(new URL('../../dist/browser/upload.js', import.meta.url), 'utf8');
    expect(`${browser}\n${upload}`).not.toMatch(/node:|sharp|ffmpeg|@volcengine|@aws-sdk|createHash/);
  });
});
