import { StorageError } from '../../core/errors.js';

export type ImageFormat = 'jpeg' | 'png' | 'webp';

export type Rgb = Readonly<{ r: number; g: number; b: number }>;

export type SharpFactory = typeof import('sharp');

export type DecodedImage = Readonly<{
  format: string;
  width: number;
  height: number;
  hasAlpha: boolean;
  pages: number;
}>;

export async function readDecodedMetadata(factory: SharpFactory, data: Uint8Array): Promise<DecodedImage> {
  try {
    const meta = await factory(data).metadata();
    if (!meta.format || meta.width === undefined || meta.height === undefined || meta.width < 1 || meta.height < 1) {
      throw new StorageError('config_invalid', 'input is not a supported image');
    }
    const pages = meta.pages !== undefined && meta.pages > 0 ? meta.pages : 1;
    return {
      format: meta.format,
      width: meta.width,
      height: meta.height,
      hasAlpha: meta.hasAlpha,
      pages,
    };
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('config_invalid', 'input is not a supported image');
  }
}

export function fitInside(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number | undefined,
  maxHeight: number | undefined,
  allowUpscale: boolean,
): { width: number; height: number } {
  if (maxWidth === undefined && maxHeight === undefined) {
    return { width: sourceWidth, height: sourceHeight };
  }
  const widthLimit = maxWidth ?? Number.POSITIVE_INFINITY;
  const heightLimit = maxHeight ?? Number.POSITIVE_INFINITY;
  let scale = Math.min(widthLimit / sourceWidth, heightLimit / sourceHeight);
  if (!Number.isFinite(scale) || scale <= 0) return { width: sourceWidth, height: sourceHeight };
  if (scale > 1 && !allowUpscale) scale = 1;
  if (scale === 1) return { width: sourceWidth, height: sourceHeight };
  let width = Math.max(1, Math.round(sourceWidth * scale));
  let height = Math.max(1, Math.round(sourceHeight * scale));
  if (maxWidth !== undefined && width > maxWidth) width = maxWidth;
  if (maxHeight !== undefined && height > maxHeight) height = maxHeight;
  return { width, height };
}

export async function encodeWithSharp(input: Readonly<{
  factory: SharpFactory;
  data: Uint8Array;
  outputFormat: ImageFormat;
  quality: number | undefined;
  background: Rgb | undefined;
  flatten: boolean;
  firstFrame: boolean;
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
}>): Promise<Uint8Array> {
  if ((input.outputFormat === 'jpeg' || input.outputFormat === 'webp') && input.quality === undefined) {
    throw new StorageError('config_missing', 'quality is required for jpeg and webp');
  }
  if (input.flatten && input.background === undefined) {
    throw new StorageError('config_invalid', 'jpeg output of an image with alpha requires background');
  }

  try {
    let pipeline = input.firstFrame ? input.factory(input.data, { pages: 1 }) : input.factory(input.data);
    if (input.flatten && input.background) {
      pipeline = pipeline.flatten({
        background: { r: input.background.r, g: input.background.g, b: input.background.b },
      });
    }
    if (input.width !== input.sourceWidth || input.height !== input.sourceHeight) {
      // Dimensions already honor allowUpscale. Sharp's default enlargement policy must not undo that.
      pipeline = pipeline.resize({
        width: input.width,
        height: input.height,
        fit: 'inside',
        withoutEnlargement: false,
      });
    }
    pipeline = applyFormat(pipeline, input.outputFormat, input.quality);
    const buffer = await pipeline.toBuffer();
    return new Uint8Array(buffer);
  } catch (error) {
    if (error instanceof StorageError) throw error;
    const message = error instanceof Error ? error.message : 'image encode failed';
    throw new StorageError('config_invalid', message);
  }
}

export async function assertEncodedFormat(
  factory: SharpFactory,
  data: Uint8Array,
  outputFormat: ImageFormat,
): Promise<void> {
  try {
    const meta = await factory(data).metadata();
    if (meta.format !== outputFormat) {
      throw new StorageError('constraint_unsatisfied', 'encoded image format did not match outputFormat');
    }
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('constraint_unsatisfied', 'encoded image could not be read');
  }
}

function applyFormat(
  pipeline: ReturnType<SharpFactory>,
  outputFormat: ImageFormat,
  quality: number | undefined,
): ReturnType<SharpFactory> {
  if (outputFormat === 'jpeg') {
    if (quality === undefined) throw new StorageError('config_missing', 'quality is required for jpeg and webp');
    return pipeline.jpeg({ quality });
  }
  if (outputFormat === 'webp') {
    if (quality === undefined) throw new StorageError('config_missing', 'quality is required for jpeg and webp');
    return pipeline.webp({ quality });
  }
  if (quality === undefined) return pipeline.png();
  return pipeline.png({ quality });
}
