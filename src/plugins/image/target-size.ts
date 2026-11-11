import { StorageError } from '../../core/errors.js';

export type TargetSize = Readonly<{
  maxOutputBytes: number;
  qualityRange: readonly [number, number];
  maxAttempts: number;
  allowFurtherResize: boolean;
}>;

export type TargetSizePlan = Readonly<{
  quality: number;
  width: number;
  height: number;
}>;

export type TargetSizeMatch = Readonly<{
  data: Uint8Array;
  plan: TargetSizePlan;
  attempts: number;
}>;

export function assertTargetSize(target: TargetSize | undefined): void {
  if (
    target === undefined ||
    target.maxOutputBytes === undefined ||
    target.qualityRange === undefined ||
    target.maxAttempts === undefined ||
    target.allowFurtherResize === undefined
  ) {
    throw new StorageError(
      'config_missing',
      'target size requires maxOutputBytes, qualityRange, maxAttempts, and allowFurtherResize',
    );
  }
  if (!isPositiveInt(target.maxOutputBytes)) {
    throw new StorageError('config_invalid', 'maxOutputBytes must be a positive integer');
  }
  if (!isPositiveInt(target.maxAttempts)) {
    throw new StorageError('config_invalid', 'maxAttempts must be a positive integer');
  }
  if (typeof target.allowFurtherResize !== 'boolean') {
    throw new StorageError('config_invalid', 'allowFurtherResize must be a boolean');
  }
  if (qualityBounds(target.qualityRange) === undefined) {
    throw new StorageError('config_invalid', 'qualityRange must be two integers from 1 to 100 with min <= max');
  }
}

export async function meetTargetSize(input: Readonly<{
  target: TargetSize;
  width: number;
  height: number;
  encode: (plan: TargetSizePlan) => Promise<Uint8Array>;
}>): Promise<TargetSizeMatch> {
  assertTargetSize(input.target);
  if (!isPositiveInt(input.width) || !isPositiveInt(input.height)) {
    throw new StorageError('config_invalid', 'width and height must be positive integers');
  }
  const bounds = qualityBounds(input.target.qualityRange);
  if (bounds === undefined) {
    throw new StorageError('config_invalid', 'qualityRange must be two integers from 1 to 100 with min <= max');
  }

  const [minQuality, maxQuality] = bounds;
  let attempts = 0;
  let width = input.width;
  let height = input.height;
  let best: { data: Uint8Array; plan: TargetSizePlan } | undefined;

  const probe = async (quality: number, probeWidth: number, probeHeight: number): Promise<Uint8Array | undefined> => {
    if (attempts >= input.target.maxAttempts) return undefined;
    attempts += 1;
    return new Uint8Array(await input.encode({ quality, width: probeWidth, height: probeHeight }));
  };

  // Higher quality is assumed not to encode smaller. The minimum is probed first so one attempt can prove this size is impossible.
  for (;;) {
    const smallest = await probe(minQuality, width, height);
    if (smallest === undefined) break;
    if (smallest.byteLength <= input.target.maxOutputBytes) {
      best = { data: smallest, plan: { quality: minQuality, width, height } };
      let low = minQuality + 1;
      let high = maxQuality;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const encoded = await probe(mid, width, height);
        if (encoded === undefined) break;
        if (encoded.byteLength <= input.target.maxOutputBytes) {
          best = { data: encoded, plan: { quality: mid, width, height } };
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      break;
    }
    if (!input.target.allowFurtherResize) break;
    const next = shrinkToFit(width, height, smallest.byteLength, input.target.maxOutputBytes);
    if (next === undefined) break;
    width = next.width;
    height = next.height;
  }

  if (best === undefined || best.data.byteLength > input.target.maxOutputBytes) {
    throw new StorageError('constraint_unsatisfied', 'output exceeds maxOutputBytes within maxAttempts');
  }
  return { data: best.data, plan: best.plan, attempts };
}

function shrinkToFit(
  width: number,
  height: number,
  bytes: number,
  maxBytes: number,
): { width: number; height: number } | undefined {
  if (width <= 1 && height <= 1) return undefined;
  // Byte size tracks pixel area, so the next box scales by the square root of the byte ratio.
  const ratio = bytes > 0 ? maxBytes / bytes : 0;
  let scale = Math.sqrt(ratio);
  if (!Number.isFinite(scale) || scale <= 0 || scale >= 1) scale = 0.5;
  let nextWidth = Math.max(1, Math.floor(width * scale));
  let nextHeight = Math.max(1, Math.floor(height * scale));
  if (nextWidth >= width && nextHeight >= height) {
    if (width >= height && width > 1) nextWidth = width - 1;
    else if (height > 1) nextHeight = height - 1;
    else return undefined;
  }
  if (nextWidth * nextHeight >= width * height) return undefined;
  return { width: nextWidth, height: nextHeight };
}

function qualityBounds(range: unknown): [number, number] | undefined {
  if (!Array.isArray(range) || range.length !== 2) return undefined;
  const min = range[0];
  const max = range[1];
  if (!isQuality(min) || !isQuality(max) || min > max) return undefined;
  return [min, max];
}

function isQuality(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}
