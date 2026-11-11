import { describe, expect, it } from 'vitest';
import { readSource } from '../../src/io/sources.js';

describe('readSource', () => {
  it('stops a stream that exceeds the byte budget', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.close();
      },
    });

    await expect(
      readSource({ kind: 'stream', stream, declaredByteLength: 8 }, { maxInputBytes: 4 }),
    ).rejects.toMatchObject({ code: 'input_too_large' });
  });

  it('rejects a stream whose declared length is already over the budget', async () => {
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );

    await expect(
      readSource({ kind: 'stream', stream, declaredByteLength: 9 }, { maxInputBytes: 4 }),
    ).rejects.toMatchObject({ code: 'input_too_large' });
    expect(pulled).toBe(false);
  });
});
