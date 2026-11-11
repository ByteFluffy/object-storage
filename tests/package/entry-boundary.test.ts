import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
const browser = readFileSync(new URL('../../src/browser/index.ts', import.meta.url), 'utf8');
const browserUpload = readFileSync(new URL('../../src/browser/upload.ts', import.meta.url), 'utf8');

describe('package entry boundary', () => {
  it('keeps Sharp, FFmpeg, and cloud SDKs out of the root entry', () => {
    expect(root).not.toMatch(/sharp|ffmpeg|ffprobe|@volcengine|@aws-sdk|node:fs/);
  });

  it('keeps Node and cloud SDKs out of the browser entry', () => {
    const source = `${browser}\n${browserUpload}`;
    expect(source).not.toMatch(/node:|sharp|ffmpeg|@volcengine|@aws-sdk|createStorage|createMemoryDriver/);
  });
});
