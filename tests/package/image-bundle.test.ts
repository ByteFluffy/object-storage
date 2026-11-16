import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { objectStorageImagePlugin } from '../../src/build/esbuild.js';

describe('image bundle runtime', () => {
  it('runs image tools from an isolated bundle without consumer image dependencies', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'object-storage-bundle-'));
    const entry = fileURLToPath(new URL('../../src/plugins/image/index.ts', import.meta.url));
    const outfile = join(directory, 'app.mjs');
    try {
      await build({
        stdin: {
          contents: `
            import { readImageMetadata } from ${JSON.stringify(entry)};
            const source = { kind: 'bytes', data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') };
            console.log(JSON.stringify(await readImageMetadata({ source })));
          `,
          resolveDir: process.cwd(),
          sourcefile: 'image-entry.ts',
        },
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile,
        plugins: [objectStorageImagePlugin()],
      });
      const output = execFileSync(process.execPath, [outfile], { cwd: directory, encoding: 'utf8' });
      expect(JSON.parse(output)).toMatchObject({ format: 'png', width: 1, height: 1 });
      expect(JSON.parse(await readFile(join(directory, 'node_modules/sharp/package.json'), 'utf8')).version).toBe('0.34.5');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
