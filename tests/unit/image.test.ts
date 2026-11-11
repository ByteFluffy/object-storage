import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { sha256Checksum } from '../../src/io/hash.js';
import {
  compressImage,
  convertImage,
  readImageMetadata,
  resizeImage,
  type LoadSharp,
  type Rgb,
  type TargetSize,
} from '../../src/plugins/image/index.js';

let solidPng!: Uint8Array;
let alphaPng!: Uint8Array;
let smallPng!: Uint8Array;
let widePng!: Uint8Array;
let noisyPng!: Uint8Array;
let animatedWebp!: Uint8Array;

beforeAll(async () => {
  solidPng = new Uint8Array(
    await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 20, g: 40, b: 60 } } }).png().toBuffer(),
  );
  alphaPng = new Uint8Array(
    await sharp({
      create: { width: 4, height: 4, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } },
    })
      .png()
      .toBuffer(),
  );
  smallPng = new Uint8Array(
    await sharp({ create: { width: 10, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer(),
  );
  widePng = new Uint8Array(
    await sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 9, g: 8, b: 7 } } }).png().toBuffer(),
  );
  const raw = Buffer.alloc(64 * 64 * 3);
  for (let index = 0; index < raw.length; index += 1) raw[index] = (index * 17 + (index % 13) * 29) & 255;
  noisyPng = new Uint8Array(await sharp(raw, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer());
  const red = await sharp({ create: { width: 8, height: 6, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .png()
    .toBuffer();
  const blue = await sharp({ create: { width: 8, height: 6, channels: 3, background: { r: 0, g: 0, b: 255 } } })
    .png()
    .toBuffer();
  animatedWebp = new Uint8Array(await sharp([red, blue], { join: { animated: true } }).webp({ quality: 80 }).toBuffer());
});

function unpulledStream(): { stream: ReadableStream<Uint8Array>; pulled: () => boolean } {
  let didPull = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        didPull = true;
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled: () => didPull };
}

function blockingSharp(mark: () => void): LoadSharp {
  return async () => {
    const { default: factory } = await import('sharp');
    return (input: unknown, options?: unknown) => {
      const instance = factory(input as never, options as never);
      instance.toBuffer = (() => {
        mark();
        throw new Error('sharp-encode-called');
      }) as typeof instance.toBuffer;
      return instance;
    };
  };
}

function countingSharp(onEncode: () => void): LoadSharp {
  return async () => {
    const { default: factory } = await import('sharp');
    return (input: unknown, options?: unknown) => {
      const instance = factory(input as never, options as never);
      const toBuffer = instance.toBuffer.bind(instance);
      instance.toBuffer = ((...args: unknown[]) => {
        onEncode();
        return toBuffer(...(args as []));
      }) as typeof instance.toBuffer;
      return instance;
    };
  };
}

async function withDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'object-storage-image-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const looseTarget: TargetSize = {
  maxOutputBytes: 1_000_000,
  qualityRange: [1, 100],
  maxAttempts: 1,
  allowFurtherResize: false,
};

describe('image plugin', () => {
  it('converts a sharp png to jpeg with distinct checksums and releases only the artifact', async () => {
    await withDirectory(async (directory) => {
      const inputPath = join(directory, 'input.png');
      await writeFile(inputPath, solidPng);
      const result = await convertImage({
        source: { kind: 'file', path: inputPath },
        outputFormat: 'jpeg',
        quality: 40,
        directory,
      });

      const output = await result.artifact.read();
      const meta = await sharp(output).metadata();
      expect(meta.format).toBe('jpeg');
      expect(result.artifact.mediaType).toBe('image/jpeg');
      expect(result.artifact.byteLength).toBe(output.byteLength);
      expect(result.inputChecksum).toEqual(sha256Checksum(solidPng));
      expect(result.outputChecksum).toEqual(sha256Checksum(output));
      expect(result.artifact.checksum).toEqual(result.outputChecksum);
      expect(result.inputChecksum).not.toBe(result.outputChecksum);
      expect(result.inputChecksum.value).not.toBe(result.outputChecksum.value);
      expect(result.artifact.path).not.toBe(inputPath);

      await result.artifact.release();
      await expect(result.artifact.read()).rejects.toMatchObject({ code: 'conflict' });
      await expect(stat(result.artifact.path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(new Uint8Array(await readFile(inputPath))).toEqual(solidPng);
      expect((await stat(dirname(result.artifact.path))).isDirectory()).toBe(true);
    });
  });

  it('does not pull the source when sharp cannot be loaded', async () => {
    const convertStream = unpulledStream();
    await expect(
      convertImage({
        source: { kind: 'stream', stream: convertStream.stream },
        outputFormat: 'png',
        loadSharp: async () => {
          throw new Error('missing sharp');
        },
      }),
    ).rejects.toMatchObject({ code: 'capability_unsupported' });
    expect(convertStream.pulled()).toBe(false);

    const metadataStream = unpulledStream();
    await expect(
      readImageMetadata({
        source: { kind: 'stream', stream: metadataStream.stream },
        loadSharp: async () => {
          throw new Error('missing sharp');
        },
      }),
    ).rejects.toMatchObject({ code: 'capability_unsupported' });
    expect(metadataStream.pulled()).toBe(false);
  });

  it('rejects an aborted signal before reading', async () => {
    const convertStream = unpulledStream();
    await expect(
      convertImage({
        source: { kind: 'stream', stream: convertStream.stream },
        outputFormat: 'png',
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(convertStream.pulled()).toBe(false);

    const metadataStream = unpulledStream();
    await expect(
      readImageMetadata({
        source: { kind: 'stream', stream: metadataStream.stream },
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(metadataStream.pulled()).toBe(false);
  });

  it('rejects input over the byte budget', async () => {
    await expect(
      readImageMetadata({
        source: { kind: 'bytes', data: solidPng },
        maxInputBytes: solidPng.byteLength - 1,
      }),
    ).rejects.toMatchObject({ code: 'input_too_large' });
  });

  it('requires caller quality for jpeg and webp before reading', async () => {
    for (const outputFormat of ['jpeg', 'webp'] as const) {
      const { stream, pulled } = unpulledStream();
      await expect(
        convertImage({ source: { kind: 'stream', stream }, outputFormat }),
      ).rejects.toMatchObject({ code: 'config_missing' });
      expect(pulled()).toBe(false);
    }

    const targetStream = unpulledStream();
    await expect(
      compressImage({
        source: { kind: 'stream', stream: targetStream.stream },
        outputFormat: 'webp',
        targetSize: looseTarget,
      }),
    ).rejects.toMatchObject({ code: 'config_missing' });
    expect(targetStream.pulled()).toBe(false);

    const invalid = unpulledStream();
    await expect(
      convertImage({ source: { kind: 'stream', stream: invalid.stream }, outputFormat: 'jpeg', quality: 0 }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    expect(invalid.pulled()).toBe(false);
  });

  it('rejects png quality outside target size mode before reading', async () => {
    const { stream, pulled } = unpulledStream();
    await expect(
      convertImage({ source: { kind: 'stream', stream }, outputFormat: 'png', quality: 40 }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    expect(pulled()).toBe(false);
  });

  it('accepts png quality in target size mode', async () => {
    await withDirectory(async (directory) => {
      const result = await compressImage({
        source: { kind: 'bytes', data: solidPng },
        outputFormat: 'png',
        quality: 40,
        directory,
        targetSize: looseTarget,
      });
      const output = await result.artifact.read();
      expect((await sharp(output).metadata()).format).toBe('png');
      expect(output.byteLength).toBeLessThanOrEqual(looseTarget.maxOutputBytes);
      await result.artifact.release();
    });
  });

  it('rejects an alpha jpeg without a complete background and does not encode', async () => {
    let encoded = false;
    const loadSharp = blockingSharp(() => {
      encoded = true;
    });
    await expect(
      convertImage({
        source: { kind: 'bytes', data: alphaPng },
        outputFormat: 'jpeg',
        quality: 40,
        loadSharp,
      }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    expect(encoded).toBe(false);

    const { stream, pulled } = unpulledStream();
    await expect(
      convertImage({
        source: { kind: 'stream', stream },
        outputFormat: 'jpeg',
        quality: 40,
        background: { r: 1 } as Rgb,
      }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    expect(pulled()).toBe(false);
  });

  it('flattens an alpha image onto the caller background for jpeg', async () => {
    await withDirectory(async (directory) => {
      const result = await convertImage({
        source: { kind: 'bytes', data: alphaPng },
        outputFormat: 'jpeg',
        quality: 90,
        background: { r: 0, g: 255, b: 0 },
        directory,
      });
      const output = await result.artifact.read();
      const decoded = await sharp(output).raw().toBuffer({ resolveWithObject: true });
      const meta = await sharp(output).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.hasAlpha).toBe(false);
      expect(decoded.data[0]).toBeGreaterThan(100);
      expect(decoded.data[1]).toBeGreaterThan(100);
      expect(decoded.data[2]).toBeLessThan(20);
      await result.artifact.release();
    });
  });

  it('keeps alpha when converting to webp without a background', async () => {
    await withDirectory(async (directory) => {
      const result = await convertImage({
        source: { kind: 'bytes', data: alphaPng },
        outputFormat: 'webp',
        quality: 40,
        directory,
      });
      const output = await result.artifact.read();
      const meta = await sharp(output).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.hasAlpha).toBe(true);
      await result.artifact.release();
    });
  });

  it('rejects multi-page input unless the caller chooses first-frame, without encoding', async () => {
    let encoded = false;
    const loadSharp = blockingSharp(() => {
      encoded = true;
    });
    await expect(
      convertImage({
        source: { kind: 'bytes', data: animatedWebp },
        outputFormat: 'png',
        loadSharp,
      }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    expect(encoded).toBe(false);

    encoded = false;
    await expect(
      convertImage({
        source: { kind: 'bytes', data: animatedWebp },
        outputFormat: 'png',
        animation: 'reject',
        loadSharp,
      }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    expect(encoded).toBe(false);
  });

  it('keeps only the first frame when animation is first-frame', async () => {
    await withDirectory(async (directory) => {
      const inputMeta = await readImageMetadata({ source: { kind: 'bytes', data: animatedWebp } });
      expect(inputMeta.pages).toBeGreaterThan(1);
      const full = await sharp(animatedWebp, { animated: true, pages: -1 }).metadata();
      expect(full.height).toBe(inputMeta.height * inputMeta.pages);

      const result = await convertImage({
        source: { kind: 'bytes', data: animatedWebp },
        outputFormat: 'png',
        animation: 'first-frame',
        directory,
      });
      const output = await result.artifact.read();
      const again = await readImageMetadata({ source: { kind: 'bytes', data: output } });
      const pixels = await sharp(output).raw().toBuffer({ resolveWithObject: true });
      expect(again.pages).toBe(1);
      expect(again.width).toBe(inputMeta.width);
      expect(again.height).toBe(inputMeta.height);
      expect(again.height).toBeLessThan(full.height ?? 0);
      expect(pixels.data[0]).toBeGreaterThan(200);
      expect(pixels.data[2]).toBeLessThan(40);
      await result.artifact.release();
    });
  });

  it('does not upscale when allowUpscale is false', async () => {
    await withDirectory(async (directory) => {
      const result = await resizeImage({
        source: { kind: 'bytes', data: smallPng },
        outputFormat: 'png',
        maxWidth: 40,
        maxHeight: 40,
        allowUpscale: false,
        directory,
      });
      const meta = await sharp(await result.artifact.read()).metadata();
      expect(meta.format).toBe('png');
      expect(meta.width).toBe(10);
      expect(meta.height).toBe(8);
      await result.artifact.release();
    });
  });

  it('upscales inside the max box when allowUpscale is true', async () => {
    await withDirectory(async (directory) => {
      const result = await resizeImage({
        source: { kind: 'bytes', data: smallPng },
        outputFormat: 'png',
        maxWidth: 40,
        maxHeight: 40,
        allowUpscale: true,
        directory,
      });
      const meta = await sharp(await result.artifact.read()).metadata();
      expect(meta.width).toBe(40);
      expect(meta.height).toBe(32);
      expect(meta.width).toBeLessThanOrEqual(40);
      expect(meta.height).toBeLessThanOrEqual(40);
      await result.artifact.release();
    });
  });

  it('downscales to the max box without exceeding either limit', async () => {
    await withDirectory(async (directory) => {
      const wide = await resizeImage({
        source: { kind: 'bytes', data: widePng },
        outputFormat: 'png',
        maxWidth: 30,
        maxHeight: 30,
        allowUpscale: false,
        directory,
      });
      const wideMeta = await sharp(await wide.artifact.read()).metadata();
      expect(wideMeta.width).toBe(30);
      expect(wideMeta.height).toBe(15);

      const narrow = await resizeImage({
        source: { kind: 'bytes', data: smallPng },
        outputFormat: 'png',
        maxWidth: 4,
        allowUpscale: false,
        directory,
      });
      const narrowMeta = await sharp(await narrow.artifact.read()).metadata();
      expect(narrowMeta.width).toBe(4);
      expect(narrowMeta.height).toBe(3);
      await wide.artifact.release();
      await narrow.artifact.release();
    });
  });

  it('rejects incomplete resize configuration before reading', async () => {
    const missingSize = unpulledStream();
    await expect(
      resizeImage({
        source: { kind: 'stream', stream: missingSize.stream },
        outputFormat: 'png',
        allowUpscale: false,
      }),
    ).rejects.toMatchObject({ code: 'config_missing' });
    expect(missingSize.pulled()).toBe(false);

    const missingFlag = unpulledStream();
    await expect(
      resizeImage({
        source: { kind: 'stream', stream: missingFlag.stream },
        outputFormat: 'png',
        maxWidth: 4,
      }),
    ).rejects.toMatchObject({ code: 'config_missing' });
    expect(missingFlag.pulled()).toBe(false);

    await expect(
      resizeImage({
        source: { kind: 'bytes', data: smallPng },
        outputFormat: 'png',
        maxWidth: 0,
        allowUpscale: false,
      }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
  });

  it('reads still and animated metadata without inventing pages', async () => {
    const still = await readImageMetadata({ source: { kind: 'bytes', data: solidPng } });
    expect(still).toEqual({ format: 'png', width: 8, height: 8, hasAlpha: false, pages: 1 });
    const alpha = await readImageMetadata({ source: { kind: 'bytes', data: alphaPng } });
    expect(alpha.hasAlpha).toBe(true);
    const animated = await readImageMetadata({ source: { kind: 'bytes', data: animatedWebp } });
    expect(animated).toMatchObject({ format: 'webp', width: 8, height: 6, pages: 2 });
  });

  it('rejects a payload that is not an image', async () => {
    await expect(
      readImageMetadata({ source: { kind: 'bytes', data: new Uint8Array([1, 2, 3, 4]) } }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
  });

  it('meets a byte limit without shrinking when quality is enough', async () => {
    await withDirectory(async (directory) => {
      const smallest = await sharp(noisyPng).webp({ quality: 1 }).toBuffer();
      const largest = await sharp(noisyPng).webp({ quality: 100 }).toBuffer();
      expect(largest.byteLength).toBeGreaterThan(smallest.byteLength);
      const limit = smallest.byteLength;
      const result = await compressImage({
        source: { kind: 'bytes', data: noisyPng },
        outputFormat: 'webp',
        quality: 1,
        directory,
        targetSize: {
          maxOutputBytes: limit,
          qualityRange: [1, 1],
          maxAttempts: 2,
          allowFurtherResize: false,
        },
      });
      const output = await result.artifact.read();
      const meta = await sharp(output).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.width).toBe(64);
      expect(meta.height).toBe(64);
      expect(output.byteLength).toBeLessThanOrEqual(limit);
      await result.artifact.release();
    });
  });

  it('does not shrink further than the requested max box when the byte limit already fits', async () => {
    await withDirectory(async (directory) => {
      const result = await resizeImage({
        source: { kind: 'bytes', data: noisyPng },
        outputFormat: 'webp',
        quality: 1,
        maxWidth: 48,
        maxHeight: 48,
        allowUpscale: false,
        directory,
        targetSize: {
          maxOutputBytes: 1_000_000,
          qualityRange: [1, 1],
          maxAttempts: 2,
          allowFurtherResize: false,
        },
      });
      const meta = await sharp(await result.artifact.read()).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.width).toBe(48);
      expect(meta.height).toBe(48);
      await result.artifact.release();
    });
  });

  it('throws constraint_unsatisfied and does not shrink when further resize is disabled', async () => {
    const smallest = await sharp(noisyPng).webp({ quality: 1 }).toBuffer();
    expect(smallest.byteLength).toBeGreaterThan(50);
    let encoded = false;
    const loadSharp = countingSharp(() => {
      encoded = true;
    });
    let resized = false;
    const resizingSharp: LoadSharp = async () => {
      const factory = (await loadSharp()) as (input: unknown, options?: unknown) => sharp.Sharp;
      return (input: unknown, options?: unknown) => {
        const instance = factory(input, options);
        const resize = instance.resize.bind(instance);
        instance.resize = ((...args: unknown[]) => {
          resized = true;
          return resize(...(args as []));
        }) as typeof instance.resize;
        return instance;
      };
    };

    await expect(
      compressImage({
        source: { kind: 'bytes', data: noisyPng },
        outputFormat: 'webp',
        quality: 1,
        loadSharp: resizingSharp,
        targetSize: {
          maxOutputBytes: 50,
          qualityRange: [1, 100],
          maxAttempts: 4,
          allowFurtherResize: false,
        },
      }),
    ).rejects.toMatchObject({ code: 'constraint_unsatisfied' });
    expect(encoded).toBe(true);
    expect(resized).toBe(false);
  });

  it('shrinks only when further resize is allowed and stays within the byte limit', async () => {
    await withDirectory(async (directory) => {
      const full = await sharp(noisyPng).webp({ quality: 1 }).toBuffer();
      const limit = 100;
      expect(full.byteLength).toBeGreaterThan(limit);
      const result = await compressImage({
        source: { kind: 'bytes', data: noisyPng },
        outputFormat: 'webp',
        quality: 1,
        directory,
        targetSize: {
          maxOutputBytes: limit,
          qualityRange: [1, 1],
          maxAttempts: 4,
          allowFurtherResize: true,
        },
      });
      const output = await result.artifact.read();
      const meta = await sharp(output).metadata();
      expect(meta.format).toBe('webp');
      expect(output.byteLength).toBeLessThanOrEqual(limit);
      expect(meta.width).toBeLessThan(64);
      expect(meta.height).toBeLessThan(64);
      await result.artifact.release();
    });
  });

  it('does not encode more than maxAttempts when the limit cannot be met', async () => {
    let encodes = 0;
    await expect(
      compressImage({
        source: { kind: 'bytes', data: noisyPng },
        outputFormat: 'webp',
        quality: 1,
        loadSharp: countingSharp(() => {
          encodes += 1;
        }),
        targetSize: {
          maxOutputBytes: 1,
          qualityRange: [1, 100],
          maxAttempts: 2,
          allowFurtherResize: true,
        },
      }),
    ).rejects.toMatchObject({ code: 'constraint_unsatisfied' });
    expect(encodes).toBeGreaterThan(0);
    expect(encodes).toBeLessThanOrEqual(2);
  });

  it('rejects incomplete conversion config', async () => {
    await expect(convertImage({ outputFormat: 'png' } as never)).rejects.toMatchObject({ code: 'config_missing' });
    await expect(convertImage({ source: { kind: 'bytes', data: solidPng } } as never)).rejects.toMatchObject({
      code: 'config_missing',
    });
    await expect(
      convertImage({ source: { kind: 'bytes', data: solidPng }, outputFormat: 'gif' } as never),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    await expect(
      compressImage({ source: { kind: 'bytes', data: solidPng }, outputFormat: 'png' }),
    ).rejects.toMatchObject({ code: 'config_missing' });
  });
});
