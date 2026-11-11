import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspace } from '../../src/io/workspace.js';

describe('createWorkspace', () => {
  it('returns a readable artifact and removes only the workspace on release', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'object-storage-ws-'));
    const userFile = join(parent, 'user-input.txt');
    await writeFile(userFile, 'keep me');
    const workspace = await createWorkspace(parent);
    const artifact = await workspace.writeArtifact('out.bin', new TextEncoder().encode('artifact'));

    expect(new TextDecoder().decode(await artifact.read())).toBe('artifact');
    await workspace.release();

    await expect(artifact.read()).rejects.toMatchObject({ code: 'conflict' });
    await expect(stat(workspace.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(userFile, 'utf8')).toBe('keep me');
  });

  it('rejects an artifact name that leaves the workspace', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'object-storage-ws-'));
    const workspace = await createWorkspace(parent);

    await expect(workspace.writeArtifact('../escape.txt', new Uint8Array([1]))).rejects.toMatchObject({
      code: 'config_invalid',
    });
    await workspace.release();
  });
});
