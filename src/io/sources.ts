import { readFile, stat } from 'node:fs/promises';
import type { Source } from '../core/contracts.js';
import { StorageError } from '../core/errors.js';

export type SourceBody = Readonly<{
  data: Uint8Array;
  byteLength: number;
}>;

export async function readSource(
  source: Source,
  options: Readonly<{ maxInputBytes?: number; signal?: AbortSignal }> = {},
): Promise<SourceBody> {
  throwIfAborted(options.signal);

  if (source.kind === 'bytes') {
    assertBudget(source.data.byteLength, options.maxInputBytes);
    return { data: source.data, byteLength: source.data.byteLength };
  }

  if (source.kind === 'file') {
    const info = await stat(source.path);
    assertBudget(info.size, options.maxInputBytes);
    const data = new Uint8Array(await readFile(source.path));
    assertBudget(data.byteLength, options.maxInputBytes);
    return { data, byteLength: data.byteLength };
  }

  if (source.declaredByteLength !== undefined) {
    assertBudget(source.declaredByteLength, options.maxInputBytes);
  }

  const reader = source.stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      throwIfAborted(options.signal);
      const next = await reader.read();
      if (next.done) break;
      if (!next.value) continue;
      total += next.value.byteLength;
      assertBudget(total, options.maxInputBytes);
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }

  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { data, byteLength: total };
}

function assertBudget(byteLength: number, maxInputBytes: number | undefined): void {
  if (maxInputBytes !== undefined && byteLength > maxInputBytes) {
    throw new StorageError('input_too_large', 'input exceeds maxInputBytes');
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new StorageError('cancelled', 'operation cancelled');
  }
}
