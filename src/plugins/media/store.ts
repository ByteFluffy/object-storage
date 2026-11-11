import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Checksum, Source } from '../../core/contracts.js';
import { StorageError } from '../../core/errors.js';
import type { ProcessingResult } from '../../core/plugin.js';
import { sha256Checksum } from '../../io/hash.js';
import { readSource } from '../../io/sources.js';
import { createWorkspace, type Workspace } from '../../io/workspace.js';
import {
  assertEncoders,
  assertExecutable,
  createBudget,
  type Budget,
} from './command.js';
import type { MediaRuntime } from './types.js';

export type Prepared = Readonly<{
  runtime: MediaRuntime;
  budget: Budget;
  hints: ReadonlyMap<string, string | null>;
  workspace: Workspace;
}>;

export type Material = Readonly<{
  path: string;
  bytes: Uint8Array;
  byteLength: number;
}>;

export async function prepare(runtime: MediaRuntime, encoders: readonly string[]): Promise<Prepared> {
  if (runtime.signal.aborted) throw new StorageError('cancelled', 'operation cancelled');
  const budget = createBudget(runtime.deadlineMs, runtime.signal);
  await assertExecutable(runtime.ffmpegPath);
  if (runtime.signal.aborted) throw new StorageError('cancelled', 'operation cancelled');
  await assertExecutable(runtime.ffprobePath);
  if (runtime.signal.aborted) throw new StorageError('cancelled', 'operation cancelled');
  const hints = encoders.length === 0 ? new Map<string, string | null>() : await assertEncoders(runtime.ffmpegPath, encoders, budget);
  if (runtime.signal.aborted) throw new StorageError('cancelled', 'operation cancelled');
  let workspace: Workspace;
  try {
    workspace = await createWorkspace(runtime.workspaceDirectory);
  } catch (error) {
    if (isMissingDirectory(error)) throw new StorageError('config_invalid', 'workspaceDirectory does not exist');
    throw error;
  }
  return { runtime, budget, hints, workspace };
}

export async function materialize(prepared: Prepared, source: Source, name: string): Promise<Material> {
  if (prepared.runtime.signal.aborted) throw new StorageError('cancelled', 'operation cancelled');
  const body = await readSource(source, {
    signal: prepared.runtime.signal,
    ...(prepared.runtime.maxInputBytes === undefined ? {} : { maxInputBytes: prepared.runtime.maxInputBytes }),
  });
  if (source.kind === 'file') {
    return { path: source.path, bytes: body.data, byteLength: body.byteLength };
  }
  const stored = await prepared.workspace.writeArtifact(name, body.data);
  return { path: stored.path, bytes: body.data, byteLength: body.byteLength };
}

export function checksumOf(parts: readonly Uint8Array[]): Checksum {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return sha256Checksum(merged);
}

export async function publish(
  workspace: Workspace,
  filename: string,
  bytes: Uint8Array,
  mediaType: string,
  inputChecksum: Checksum,
): Promise<ProcessingResult> {
  if (bytes.byteLength === 0) throw new StorageError('unavailable', 'media tool wrote an empty output');
  const outputChecksum = sha256Checksum(bytes);
  const stored = await workspace.writeArtifact(filename, bytes);
  let released = false;
  return {
    inputChecksum,
    outputChecksum,
    artifact: {
      path: stored.path,
      byteLength: stored.byteLength,
      mediaType,
      checksum: outputChecksum,
      read: () => stored.read(),
      async release() {
        if (released) return;
        released = true;
        await workspace.release();
      },
    },
  };
}

export async function readProduced(filePath: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(filePath));
  } catch (error) {
    if (isMissingDirectory(error)) throw new StorageError('unavailable', 'media tool did not write an output');
    throw error;
  }
}

export async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if (isMissingDirectory(error)) throw new StorageError('unavailable', 'media tool did not write an output');
    throw error;
  }
}

export function workspaceFile(workspace: Workspace, name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new StorageError('config_invalid', 'workspace file name is invalid');
  return join(workspace.directory, name);
}

export async function writeWorkspaceText(workspace: Workspace, name: string, text: string): Promise<string> {
  const fullPath = workspaceFile(workspace, name);
  await writeFile(fullPath, text);
  return fullPath;
}

export async function discard(prepared: Prepared): Promise<void> {
  await prepared.workspace.release();
}

function isMissingDirectory(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}
