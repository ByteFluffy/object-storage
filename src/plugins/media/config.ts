import type { Source } from '../../core/contracts.js';
import { StorageError } from '../../core/errors.js';
import type {
  AudioContainer,
  AudioSettings,
  MediaRuntime,
  TrimPrecision,
  VideoContainer,
  VideoSettings,
} from './types.js';

const VIDEO_CONTAINERS: readonly VideoContainer[] = ['mp4', 'webm', 'mkv'];
const AUDIO_CONTAINERS: readonly AudioContainer[] = ['mp3', 'm4a', 'wav'];

export function readRuntime(input: object): MediaRuntime {
  const record = asRecord(input, 'request');
  const ffmpegPath = requireString(record.ffmpegPath, 'ffmpegPath');
  const ffprobePath = requireString(record.ffprobePath, 'ffprobePath');
  const workspaceDirectory = requireString(record.workspaceDirectory, 'workspaceDirectory');
  if (record.deadlineMs === undefined) throw new StorageError('config_missing', 'deadlineMs is required');
  const deadlineMs = requireNumber(record.deadlineMs, 'deadlineMs', { minExclusive: 0 });
  if (record.signal === undefined) throw new StorageError('config_missing', 'signal is required');
  if (!(record.signal instanceof AbortSignal)) throw new StorageError('config_invalid', 'signal is invalid');
  const maxInputBytes = optionalNumber(record.maxInputBytes, 'maxInputBytes', { minExclusive: 0, integer: true });
  return {
    ffmpegPath,
    ffprobePath,
    workspaceDirectory,
    deadlineMs,
    signal: record.signal,
    ...(maxInputBytes === undefined ? {} : { maxInputBytes }),
  };
}

export function readSingleSource(value: unknown): Source {
  if (value === undefined) throw new StorageError('config_missing', 'source is required');
  return readSourceValue(value, 'source');
}

export function readConcatSources(value: unknown): readonly Source[] {
  if (value === undefined) throw new StorageError('config_missing', 'sources is required');
  if (!Array.isArray(value)) throw new StorageError('config_invalid', 'sources is invalid');
  if (value.length < 2) throw new StorageError('config_invalid', 'concat requires at least two sources');
  return value.map((item, index) => readSourceValue(item, `sources[${index}]`));
}

export function readVideoContainer(value: unknown): VideoContainer {
  return readChoice(value, VIDEO_CONTAINERS, 'container');
}

export function readAudioContainer(value: unknown): AudioContainer {
  return readChoice(value, AUDIO_CONTAINERS, 'container');
}

export function readTrimContainer(value: unknown): VideoContainer | AudioContainer {
  if (value === undefined) throw new StorageError('config_missing', 'container is required');
  if (isChoice(value, VIDEO_CONTAINERS)) return value;
  if (isChoice(value, AUDIO_CONTAINERS)) return value;
  throw new StorageError('config_invalid', 'container is invalid');
}

export function readVideoSettings(value: unknown, name = 'video'): VideoSettings {
  const record = asRecord(value, name);
  const encoder = requireString(record.encoder, `${name}.encoder`);
  if (record.bitrate === undefined) throw new StorageError('config_missing', `${name}.bitrate is required`);
  const bitrate = requireNumber(record.bitrate, `${name}.bitrate`, { minExclusive: 0, integer: true });
  const fps = optionalNumber(record.fps, `${name}.fps`, { minExclusive: 0 });
  const width = optionalNumber(record.width, `${name}.width`, { minExclusive: 0, integer: true });
  const height = optionalNumber(record.height, `${name}.height`, { minExclusive: 0, integer: true });
  assertDimensions(width, height, name);
  return {
    encoder,
    bitrate,
    ...(fps === undefined ? {} : { fps }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

export function readAudioSettings(value: unknown, name = 'audio'): AudioSettings {
  const record = asRecord(value, name);
  const encoder = requireString(record.encoder, `${name}.encoder`);
  if (record.bitrate === undefined) throw new StorageError('config_missing', `${name}.bitrate is required`);
  const bitrate = requireNumber(record.bitrate, `${name}.bitrate`, { minExclusive: 0, integer: true });
  const sampleRate = optionalNumber(record.sampleRate, `${name}.sampleRate`, { minExclusive: 0, integer: true });
  return {
    encoder,
    bitrate,
    ...(sampleRate === undefined ? {} : { sampleRate }),
  };
}

export function readOptionalVideo(value: unknown): VideoSettings | undefined {
  if (value === undefined) return undefined;
  return readVideoSettings(value);
}

export function readOptionalAudio(value: unknown): AudioSettings | undefined {
  if (value === undefined) return undefined;
  return readAudioSettings(value);
}

export function readDropAudio(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new StorageError('config_invalid', 'dropAudio is invalid');
  return value;
}

export function readAllowNormalize(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new StorageError('config_invalid', 'allowNormalize is invalid');
  return value;
}

export function readPrecision(value: unknown): TrimPrecision {
  if (value === undefined) throw new StorageError('config_missing', 'precision is required');
  if (value === 'keyframe' || value === 'exact') return value;
  throw new StorageError('config_invalid', 'precision is invalid');
}

export function readTolerance(value: unknown): number {
  if (value === undefined) throw new StorageError('config_missing', 'durationToleranceMs is required');
  return requireNumber(value, 'durationToleranceMs', { min: 0 });
}

export function readOptionalDimension(value: unknown, name: string): number | undefined {
  return optionalNumber(value, name, { minExclusive: 0, integer: true });
}

export function assertDimensions(width: number | undefined, height: number | undefined, name: string): void {
  if ((width === undefined) !== (height === undefined)) {
    throw new StorageError('config_invalid', `${name} width and height must both be set`);
  }
}

export function assertAudioChoice(dropAudio: boolean, audio: AudioSettings | undefined): void {
  if (dropAudio && audio) {
    throw new StorageError('config_invalid', 'dropAudio cannot be combined with audio settings');
  }
}

export function mediaTypeFor(container: string): string {
  switch (container) {
    case 'mp4':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'mkv':
      return 'video/x-matroska';
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
      return 'audio/mp4';
    case 'wav':
      return 'audio/wav';
    case 'png':
      return 'image/png';
    default:
      throw new StorageError('config_invalid', 'container is invalid');
  }
}

function readSourceValue(value: unknown, name: string): Source {
  const record = asRecord(value, name);
  if (record.kind === 'bytes') {
    if (!(record.data instanceof Uint8Array)) throw new StorageError('config_invalid', `${name}.data is invalid`);
    return { kind: 'bytes', data: record.data };
  }
  if (record.kind === 'file') {
    return { kind: 'file', path: requireString(record.path, `${name}.path`) };
  }
  if (record.kind === 'stream') {
    if (!(record.stream instanceof ReadableStream)) {
      throw new StorageError('config_invalid', `${name}.stream is invalid`);
    }
    const declared = optionalNumber(record.declaredByteLength, `${name}.declaredByteLength`, { min: 0, integer: true });
    return {
      kind: 'stream',
      stream: record.stream as ReadableStream<Uint8Array>,
      ...(declared === undefined ? {} : { declaredByteLength: declared }),
    };
  }
  if (record.kind === undefined) throw new StorageError('config_missing', `${name}.kind is required`);
  throw new StorageError('config_invalid', `${name}.kind is invalid`);
}

function readChoice<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (value === undefined) throw new StorageError('config_missing', `${name} is required`);
  if (!isChoice(value, allowed)) throw new StorageError('config_invalid', `${name} is invalid`);
  return value;
}

function isChoice<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined || value === null) throw new StorageError('config_missing', `${name} is required`);
  if (typeof value !== 'object' || Array.isArray(value)) throw new StorageError('config_invalid', `${name} is invalid`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (value === undefined) throw new StorageError('config_missing', `${name} is required`);
  if (typeof value !== 'string' || value.length === 0) throw new StorageError('config_invalid', `${name} is invalid`);
  return value;
}

function requireNumber(
  value: unknown,
  name: string,
  rule: { min?: number; minExclusive?: number; integer?: boolean },
): number {
  if (!isFiniteNumber(value, rule)) throw new StorageError('config_invalid', `${name} is invalid`);
  return value;
}

function optionalNumber(
  value: unknown,
  name: string,
  rule: { min?: number; minExclusive?: number; integer?: boolean },
): number | undefined {
  if (value === undefined) return undefined;
  return requireNumber(value, name, rule);
}

function isFiniteNumber(
  value: unknown,
  rule: { min?: number; minExclusive?: number; integer?: boolean },
): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (rule.integer && !Number.isInteger(value)) return false;
  if (rule.min !== undefined && value < rule.min) return false;
  if (rule.minExclusive !== undefined && value <= rule.minExclusive) return false;
  return true;
}
