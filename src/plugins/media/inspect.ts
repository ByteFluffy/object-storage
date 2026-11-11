import { StorageError } from '../../core/errors.js';
import { remainingMs, runCommand, type Budget } from './command.js';
import type { AudioStreamInfo, MediaInfo, VideoStreamInfo } from './types.js';

export type MediaExpectation = Readonly<{
  container: string;
  durationMs?: number;
  durationToleranceMs?: number;
  videoCodec?: string | null;
  audioCodec?: string | null;
  width?: number;
  height?: number;
  fps?: number;
  sampleRate?: number;
}>;

export async function probeFile(ffprobePath: string, filePath: string, budget: Budget): Promise<MediaInfo> {
  const { stdout } = await runCommand(
    ffprobePath,
    ['-hide_banner', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { timeoutMs: remainingMs(budget), signal: budget.signal },
  );
  return parseProbe(stdout);
}

export function parseProbe(stdout: Buffer): MediaInfo {
  const text = stdout.toString('utf8').trim();
  const start = text.indexOf('{');
  if (start < 0) throw new StorageError('unavailable', 'ffprobe did not return json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start)) as unknown;
  } catch {
    throw new StorageError('unavailable', 'ffprobe returned invalid json');
  }
  const root = asRecord(parsed);
  if (!root) throw new StorageError('unavailable', 'ffprobe returned invalid json');
  const format = asRecord(root.format);
  const formatName = typeof format?.format_name === 'string' ? format.format_name : '';
  if (formatName.length === 0) throw new StorageError('unavailable', 'ffprobe did not report a container');
  const streams = Array.isArray(root.streams) ? root.streams : [];
  let video: VideoStreamInfo | null = null;
  let audio: AudioStreamInfo | null = null;
  const durations: number[] = [];
  const formatDuration = durationMs(format?.duration);
  if (formatDuration !== undefined) durations.push(formatDuration);
  for (const entry of streams) {
    const stream = asRecord(entry);
    if (!stream) continue;
    const streamDuration = durationMs(stream.duration);
    if (streamDuration !== undefined) durations.push(streamDuration);
    if (stream.codec_type === 'video' && video === null) {
      const codec = typeof stream.codec_name === 'string' ? stream.codec_name : '';
      const width = typeof stream.width === 'number' ? stream.width : 0;
      const height = typeof stream.height === 'number' ? stream.height : 0;
      if (codec.length === 0 || width <= 0 || height <= 0) {
        throw new StorageError('unavailable', 'ffprobe video stream is incomplete');
      }
      video = { codec, width, height, fps: frameRate(stream) };
    }
    if (stream.codec_type === 'audio' && audio === null) {
      const codec = typeof stream.codec_name === 'string' ? stream.codec_name : '';
      const sampleRate = typeof stream.sample_rate === 'string' ? Number(stream.sample_rate) : Number.NaN;
      const channels = typeof stream.channels === 'number' ? stream.channels : 0;
      if (codec.length === 0 || !Number.isFinite(sampleRate) || channels <= 0) {
        throw new StorageError('unavailable', 'ffprobe audio stream is incomplete');
      }
      audio = { codec, sampleRate, channels };
    }
  }
  return {
    formatName,
    durationMs: durations[0] ?? 0,
    video,
    audio,
  };
}

export function assertOutput(info: MediaInfo, expected: MediaExpectation): void {
  if (!containerMatches(info.formatName, expected.container)) {
    throw new StorageError('constraint_unsatisfied', `output container is ${info.formatName}`);
  }
  if (expected.videoCodec === null && info.video) {
    throw new StorageError('constraint_unsatisfied', 'output contains an unexpected video track');
  }
  if (typeof expected.videoCodec === 'string') {
    if (!info.video) throw new StorageError('constraint_unsatisfied', 'output is missing the video track');
    if (info.video.codec !== expected.videoCodec) {
      throw new StorageError('constraint_unsatisfied', `output video codec is ${info.video.codec}`);
    }
    if (expected.width !== undefined && info.video.width !== expected.width) {
      throw new StorageError('constraint_unsatisfied', `output width is ${info.video.width}`);
    }
    if (expected.height !== undefined && info.video.height !== expected.height) {
      throw new StorageError('constraint_unsatisfied', `output height is ${info.video.height}`);
    }
    if (expected.fps !== undefined && Math.abs(info.video.fps - expected.fps) > 0.05) {
      throw new StorageError('constraint_unsatisfied', `output frame rate is ${info.video.fps}`);
    }
  }
  if (expected.audioCodec === null && info.audio) {
    throw new StorageError('constraint_unsatisfied', 'output contains an unexpected audio track');
  }
  if (typeof expected.audioCodec === 'string') {
    if (!info.audio) throw new StorageError('constraint_unsatisfied', 'output is missing the audio track');
    if (info.audio.codec !== expected.audioCodec) {
      throw new StorageError('constraint_unsatisfied', `output audio codec is ${info.audio.codec}`);
    }
    if (expected.sampleRate !== undefined && info.audio.sampleRate !== expected.sampleRate) {
      throw new StorageError('constraint_unsatisfied', `output sample rate is ${info.audio.sampleRate}`);
    }
  }
  if (expected.durationMs !== undefined && expected.durationToleranceMs !== undefined) {
    const delta = Math.abs(info.durationMs - expected.durationMs);
    if (delta > expected.durationToleranceMs) {
      throw new StorageError(
        'constraint_unsatisfied',
        `duration ${info.durationMs}ms is outside ${expected.durationMs}±${expected.durationToleranceMs}ms`,
      );
    }
  }
}

export function sameStreams(left: MediaInfo, right: MediaInfo): boolean {
  if (!left.video || !right.video) return false;
  if (left.video.codec !== right.video.codec) return false;
  if (left.video.width !== right.video.width || left.video.height !== right.video.height) return false;
  if (Math.abs(left.video.fps - right.video.fps) > 0.01) return false;
  if (!left.audio && !right.audio) return true;
  if (!left.audio || !right.audio) return false;
  return left.audio.codec === right.audio.codec
    && left.audio.sampleRate === right.audio.sampleRate
    && left.audio.channels === right.audio.channels;
}

function containerMatches(formatName: string, container: string): boolean {
  const tokens = formatName.toLowerCase().split(/[^a-z0-9_]+/).filter((token) => token.length > 0);
  const has = (token: string) => tokens.includes(token);
  switch (container) {
    case 'mp4':
    case 'm4a':
      return has('mp4') || has('m4a') || has('mov') || has('isom');
    case 'webm':
      return has('webm');
    case 'mkv':
      return has('matroska');
    case 'mp3':
      return has('mp3');
    case 'wav':
      return has('wav');
    case 'png':
      return tokens.some((token) => token === 'png' || token.startsWith('png_') || token === 'image2');
    default:
      return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function durationMs(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const seconds = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

function frameRate(stream: Record<string, unknown>): number {
  const primary = rate(stream.r_frame_rate);
  if (primary > 0) return primary;
  return rate(stream.avg_frame_rate);
}

function rate(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const [numerator, denominator] = value.split('/');
  const num = Number(numerator);
  const den = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return num / den;
}
