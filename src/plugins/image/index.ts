import { tmpdir } from 'node:os';
import type { Source } from '../../core/contracts.js';
import { StorageError } from '../../core/errors.js';
import type { ProcessingResult } from '../../core/plugin.js';
import { sha256Checksum } from '../../io/hash.js';
import { readSource } from '../../io/sources.js';
import { createWorkspace } from '../../io/workspace.js';
import { assertTargetSize, meetTargetSize, type TargetSize } from './target-size.js';
import {
  assertEncodedFormat,
  encodeWithSharp,
  fitInside,
  readDecodedMetadata,
  type ImageFormat,
  type Rgb,
  type SharpFactory,
} from './transform.js';

export type { Rgb, TargetSize };
export type LoadSharp = () => Promise<unknown>;

export type ImageMetadata = Readonly<{
  format: string;
  width: number;
  height: number;
  hasAlpha: boolean;
  pages: number;
}>;

type AnimationPolicy = 'reject' | 'first-frame';

type BaseRequest = Readonly<{
  source: Source;
  background?: Rgb;
  animation?: AnimationPolicy;
  maxInputBytes?: number;
  signal?: AbortSignal;
  directory?: string;
  loadSharp?: LoadSharp;
}>;

export type ConvertImageRequest = BaseRequest & Readonly<{
  outputFormat: ImageFormat;
  quality?: number;
  targetSize?: TargetSize;
}>;

export type ResizeImageRequest = BaseRequest & Readonly<{
  outputFormat: ImageFormat;
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  allowUpscale?: boolean;
  targetSize?: TargetSize;
}>;

export type CompressImageRequest = BaseRequest & Readonly<{
  outputFormat: ImageFormat;
  quality?: number;
  targetSize?: TargetSize;
}>;

export type ReadImageMetadataRequest = Readonly<{
  source: Source;
  maxInputBytes?: number;
  signal?: AbortSignal;
  loadSharp?: LoadSharp;
}>;

type Mode = 'convert' | 'resize' | 'compress';

type RuntimeRequest = {
  source?: Source;
  outputFormat?: unknown;
  quality?: unknown;
  background?: unknown;
  animation?: unknown;
  maxInputBytes?: number;
  signal?: AbortSignal;
  directory?: string;
  loadSharp?: LoadSharp;
  maxWidth?: unknown;
  maxHeight?: unknown;
  allowUpscale?: unknown;
  targetSize?: TargetSize;
};

type ResizeLimits = Readonly<{
  maxWidth?: number;
  maxHeight?: number;
  allowUpscale: boolean;
}>;

type Spec = Readonly<{
  source: Source;
  outputFormat: ImageFormat;
  quality: number | undefined;
  background: Rgb | undefined;
  animation: AnimationPolicy | undefined;
  maxInputBytes: number | undefined;
  signal: AbortSignal | undefined;
  directory: string | undefined;
  loadSharp: LoadSharp | undefined;
  resize: ResizeLimits | undefined;
  targetSize: TargetSize | undefined;
}>;

const defaultLoadSharp: LoadSharp = () => import('sharp');

export async function convertImage(request: ConvertImageRequest): Promise<ProcessingResult> {
  return processImage(request, 'convert');
}

export async function resizeImage(request: ResizeImageRequest): Promise<ProcessingResult> {
  return processImage(request, 'resize');
}

export async function compressImage(request: CompressImageRequest): Promise<ProcessingResult> {
  return processImage(request, 'compress');
}

export async function readImageMetadata(request: ReadImageMetadataRequest): Promise<ImageMetadata> {
  if (request === undefined || request.source === undefined) {
    throw new StorageError('config_missing', 'source is required');
  }
  const opened = await openImage(request);
  return readDecodedMetadata(opened.factory, opened.data);
}

async function processImage(
  request: ConvertImageRequest | ResizeImageRequest | CompressImageRequest,
  mode: Mode,
): Promise<ProcessingResult> {
  const spec = validate(request, mode);
  const opened = await openImage(spec);
  const decoded = await readDecodedMetadata(opened.factory, opened.data);
  assertPages(decoded.pages, spec.animation);
  const flatten = spec.outputFormat === 'jpeg' && decoded.hasAlpha;
  if (flatten && spec.background === undefined) {
    throw new StorageError('config_invalid', 'jpeg output of an image with alpha requires background');
  }

  const fitted = spec.resize
    ? fitInside(decoded.width, decoded.height, spec.resize.maxWidth, spec.resize.maxHeight, spec.resize.allowUpscale)
    : { width: decoded.width, height: decoded.height };
  const encode = (width: number, height: number, quality: number | undefined) => {
    throwIfAborted(spec.signal);
    return encodeWithSharp({
      factory: opened.factory,
      data: opened.data,
      outputFormat: spec.outputFormat,
      quality,
      background: spec.background,
      flatten,
      firstFrame: spec.animation === 'first-frame',
      sourceWidth: decoded.width,
      sourceHeight: decoded.height,
      width,
      height,
    });
  };

  const output = spec.targetSize
    ? (
        await meetTargetSize({
          target: spec.targetSize,
          width: fitted.width,
          height: fitted.height,
          encode: (plan) => encode(plan.width, plan.height, plan.quality),
        })
      ).data
    : await encode(fitted.width, fitted.height, spec.quality);

  await assertEncodedFormat(opened.factory, output, spec.outputFormat);
  const outputChecksum = sha256Checksum(output);
  const workspace = await createWorkspace(spec.directory ?? tmpdir());
  const artifact = await workspace.writeArtifact(`output.${spec.outputFormat}`, output);
  return {
    artifact: {
      path: artifact.path,
      byteLength: artifact.byteLength,
      mediaType: mediaTypeOf(spec.outputFormat),
      checksum: outputChecksum,
      read: () => artifact.read(),
      release: () => artifact.release(),
    },
    inputChecksum: opened.checksum,
    outputChecksum,
  };
}

async function openImage(request: Readonly<{
  source: Source;
  maxInputBytes?: number;
  signal?: AbortSignal;
  loadSharp?: LoadSharp;
}>): Promise<{ factory: SharpFactory; data: Uint8Array; checksum: ReturnType<typeof sha256Checksum> }> {
  throwIfAborted(request.signal);
  const factory = await resolveSharp(request.loadSharp ?? defaultLoadSharp);
  throwIfAborted(request.signal);
  const body = await readSource(request.source, {
    ...(request.maxInputBytes === undefined ? {} : { maxInputBytes: request.maxInputBytes }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  return { factory, data: body.data, checksum: sha256Checksum(body.data) };
}

async function resolveSharp(load: LoadSharp): Promise<SharpFactory> {
  let loaded: unknown;
  try {
    loaded = await load();
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('capability_unsupported', 'sharp is unavailable');
  }
  if (typeof loaded === 'function') return loaded as SharpFactory;
  if (typeof loaded === 'object' && loaded !== null && 'default' in loaded && typeof loaded.default === 'function') {
    return loaded.default as SharpFactory;
  }
  throw new StorageError('capability_unsupported', 'sharp is unavailable');
}

function validate(request: RuntimeRequest | undefined, mode: Mode): Spec {
  if (request === undefined || request.source === undefined) {
    throw new StorageError('config_missing', 'source is required');
  }
  const outputFormat = assertOutputFormat(request.outputFormat);
  const resize = mode === 'resize' ? assertResize(request) : undefined;
  if (mode === 'compress' && request.targetSize === undefined) {
    throw new StorageError('config_missing', 'target size is required');
  }
  if (request.targetSize !== undefined) assertTargetSize(request.targetSize);
  return {
    source: request.source,
    outputFormat,
    quality: assertQuality(outputFormat, request.quality, request.targetSize !== undefined),
    background: assertBackground(request.background),
    animation: assertAnimation(request.animation),
    maxInputBytes: request.maxInputBytes,
    signal: request.signal,
    directory: request.directory,
    loadSharp: request.loadSharp,
    resize,
    targetSize: request.targetSize,
  };
}

function assertOutputFormat(format: unknown): ImageFormat {
  if (format === undefined) throw new StorageError('config_missing', 'outputFormat is required');
  if (format !== 'jpeg' && format !== 'png' && format !== 'webp') {
    throw new StorageError('config_invalid', 'outputFormat must be jpeg, png, or webp');
  }
  return format;
}

function assertResize(request: RuntimeRequest): ResizeLimits {
  if (request.maxWidth === undefined && request.maxHeight === undefined) {
    throw new StorageError('config_missing', 'resize requires maxWidth or maxHeight');
  }
  if (request.allowUpscale === undefined) {
    throw new StorageError('config_missing', 'allowUpscale is required');
  }
  if (typeof request.allowUpscale !== 'boolean') {
    throw new StorageError('config_invalid', 'allowUpscale must be a boolean');
  }
  if (request.maxWidth !== undefined && !isPositiveInt(request.maxWidth)) {
    throw new StorageError('config_invalid', 'maxWidth must be a positive integer');
  }
  if (request.maxHeight !== undefined && !isPositiveInt(request.maxHeight)) {
    throw new StorageError('config_invalid', 'maxHeight must be a positive integer');
  }
  return {
    ...(isPositiveInt(request.maxWidth) ? { maxWidth: request.maxWidth } : {}),
    ...(isPositiveInt(request.maxHeight) ? { maxHeight: request.maxHeight } : {}),
    allowUpscale: request.allowUpscale,
  };
}

function assertQuality(format: ImageFormat, quality: unknown, targetMode: boolean): number | undefined {
  if (format === 'png') {
    if (quality !== undefined && !targetMode) {
      throw new StorageError('config_invalid', 'png quality requires target size mode');
    }
    if (quality !== undefined && !isQuality(quality)) {
      throw new StorageError('config_invalid', 'quality must be an integer from 1 to 100');
    }
    return isQuality(quality) ? quality : undefined;
  }
  if (quality === undefined) {
    throw new StorageError('config_missing', 'quality is required for jpeg and webp');
  }
  if (!isQuality(quality)) {
    throw new StorageError('config_invalid', 'quality must be an integer from 1 to 100');
  }
  return quality;
}

function assertBackground(background: unknown): Rgb | undefined {
  if (background === undefined) return undefined;
  if (typeof background !== 'object' || background === null) {
    throw new StorageError('config_invalid', 'background must be { r, g, b }');
  }
  const record = background as { r?: unknown; g?: unknown; b?: unknown };
  if (!isChannel(record.r) || !isChannel(record.g) || !isChannel(record.b)) {
    throw new StorageError('config_invalid', 'background must be { r, g, b } integers from 0 to 255');
  }
  return { r: record.r, g: record.g, b: record.b };
}

function assertAnimation(animation: unknown): AnimationPolicy | undefined {
  if (animation === undefined) return undefined;
  if (animation === 'reject' || animation === 'first-frame') return animation;
  throw new StorageError('config_invalid', 'animation must be reject or first-frame');
}

function assertPages(pages: number, animation: AnimationPolicy | undefined): void {
  if (pages <= 1) return;
  if (animation === undefined) {
    throw new StorageError('config_invalid', 'multi-page input requires animation policy');
  }
  if (animation === 'reject') {
    throw new StorageError('config_invalid', 'animated input rejected');
  }
}

function mediaTypeOf(format: ImageFormat): string {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'png') return 'image/png';
  return 'image/webp';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new StorageError('cancelled', 'operation cancelled');
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isQuality(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100;
}

function isChannel(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;
}
