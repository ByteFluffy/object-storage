import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createStorage } from '../../dist/index.js';
import { executeDirectUpload } from '../../dist/browser/index.js';
import { convertImage } from '../../dist/plugins/image/index.js';
import { probeMedia } from '../../dist/plugins/media/index.js';
import { checkObject } from '../../dist/plugins/probe/index.js';
import { cleanObjects } from '../../dist/plugins/cleanup/index.js';
import { createTosDriver } from '../../dist/drivers/tos.js';
import { createS3Driver } from '../../dist/drivers/s3.js';
import { createSingleGetPlan, createSinglePutPlan } from '../../dist/server/index.js';
import { assessDelivery } from '../../dist/delivery/fit.js';

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

  it('keeps Sharp, FFmpeg, and cloud SDKs out of the built root import graph', () => {
    const graph = readImportGraph(new URL('../../dist/index.js', import.meta.url));
    expect(graph).not.toMatch(/sharp|ffmpeg|ffprobe|@volcengine\/tos-sdk|@aws-sdk\//);
  });

  it('loads the optional subpath entries', () => {
    expect(typeof convertImage).toBe('function');
    expect(typeof probeMedia).toBe('function');
    expect(typeof checkObject).toBe('function');
    expect(typeof cleanObjects).toBe('function');
    expect(typeof createTosDriver).toBe('function');
    expect(typeof createS3Driver).toBe('function');
    expect(typeof createSinglePutPlan).toBe('function');
    expect(typeof createSingleGetPlan).toBe('function');
    expect(typeof assessDelivery).toBe('function');
  });
});

function readImportGraph(entry: URL): string {
  const seen = new Set<string>();
  const chunks: string[] = [];
  const queue = [fileURLToPath(entry)];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const text = readFileSync(current, 'utf8');
    chunks.push(text);
    for (const match of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const spec = match[1];
      if (spec === undefined) continue;
      const next = resolve(dirname(current), spec.endsWith('.js') ? spec : `${spec}.js`);
      queue.push(next);
    }
  }
  return chunks.join('\n');
}
