import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { StorageError } from '../core/errors.js';

export type Artifact = Readonly<{
  path: string;
  byteLength: number;
  read(): Promise<Uint8Array>;
  release(): Promise<void>;
}>;

export type Workspace = Readonly<{
  directory: string;
  writeArtifact(name: string, data: Uint8Array): Promise<Artifact>;
  release(): Promise<void>;
}>;

export async function createWorkspace(parentDirectory: string): Promise<Workspace> {
  const directory = await mkdtemp(join(parentDirectory, 'object-storage-'));
  let released = false;

  return {
    directory,
    async writeArtifact(name, data) {
      if (released) throw new StorageError('conflict', 'workspace released');
      const fullPath = resolveArtifactPath(directory, name);
      await writeFile(fullPath, data);
      return {
        path: fullPath,
        byteLength: data.byteLength,
        async read() {
          if (released) throw new StorageError('conflict', 'workspace released');
          try {
            return new Uint8Array(await readFile(fullPath));
          } catch (error) {
            if (isNotFound(error)) throw new StorageError('conflict', 'artifact released');
            throw error;
          }
        },
        async release() {
          await rm(fullPath, { force: true });
        },
      };
    },
    async release() {
      released = true;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function resolveArtifactPath(directory: string, name: string): string {
  if (name.length === 0 || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new StorageError('config_invalid', 'artifact name must stay inside the workspace');
  }
  const root = resolve(directory);
  const fullPath = resolve(root, name);
  if (fullPath !== root && !fullPath.startsWith(`${root}${sep}`)) {
    throw new StorageError('config_invalid', 'artifact name must stay inside the workspace');
  }
  return fullPath;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
