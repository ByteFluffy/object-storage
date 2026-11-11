import { StorageError } from '../../core/errors.js';
import type { ProcessingResult } from '../../core/plugin.js';
import { outputCodec, remainingMs, runCommand, seconds } from './command.js';
import {
  assertAudioChoice,
  assertDimensions,
  mediaTypeFor,
  readAllowNormalize,
  readAudioContainer,
  readAudioSettings,
  readConcatSources,
  readDropAudio,
  readOptionalAudio,
  readOptionalDimension,
  readOptionalVideo,
  readPrecision,
  readRuntime,
  readSingleSource,
  readTolerance,
  readTrimContainer,
  readVideoContainer,
  readVideoSettings,
} from './config.js';
import { assertOutput, probeFile, sameStreams, type MediaExpectation } from './inspect.js';
import {
  checksumOf,
  discard,
  fileSize,
  materialize,
  prepare,
  publish,
  readProduced,
  workspaceFile,
  writeWorkspaceText,
  type Material,
  type Prepared,
} from './store.js';
import type {
  AudioSettings,
  CompressVideoRequest,
  ConcatMediaRequest,
  ExtractFrameRequest,
  MediaInfo,
  MediaProbe,
  ProbeMediaRequest,
  TranscodeAudioRequest,
  TranscodeVideoRequest,
  TrimMediaRequest,
  TrimMediaResult,
  VideoSettings,
} from './types.js';

export type {
  AudioSettings,
  CompressVideoRequest,
  ConcatMediaRequest,
  ExtractFrameRequest,
  MediaProbe,
  ProbeMediaRequest,
  TranscodeAudioRequest,
  TranscodeVideoRequest,
  TrimMediaRequest,
  TrimMediaResult,
  VideoSettings,
} from './types.js';

export async function probeMedia(input: ProbeMediaRequest): Promise<MediaProbe> {
  const runtime = readRuntime(input);
  const source = readSingleSource(input.source);
  if (runtime.signal.aborted) throw new StorageError('cancelled', 'operation cancelled');
  const prepared = await prepare(runtime, []);
  try {
    const material = await materialize(prepared, source, 'input.bin');
    const info = await probeFile(runtime.ffprobePath, material.path, prepared.budget);
    return { ...info, byteLength: material.byteLength, inputChecksum: checksumOf([material.bytes]) };
  } finally {
    await discard(prepared);
  }
}

export async function transcodeVideo(input: TranscodeVideoRequest): Promise<ProcessingResult> {
  const runtime = readRuntime(input);
  const source = readSingleSource(input.source);
  const container = readVideoContainer(input.container);
  const video = readVideoSettings(input.video);
  const audio = readOptionalAudio(input.audio);
  const dropAudio = readDropAudio(input.dropAudio);
  const durationToleranceMs = readTolerance(input.durationToleranceMs);
  assertAudioChoice(dropAudio, audio);
  assertDimensions(video.width, video.height, 'video');
  if (runtime.signal.aborted) throw new StorageError('cancelled', 'operation cancelled');
  const prepared = await prepare(runtime, encoderList(video.encoder, audio));
  return run(prepared, async () => {
    const material = await materialize(prepared, source, 'input.bin');
    const info = await probeFile(runtime.ffprobePath, material.path, prepared.budget);
    if (!info.video) throw new StorageError('config_invalid', 'input has no video track');
    const kept = keepAudio(info, dropAudio, audio);
    const output = workspaceFile(prepared.workspace, `output.${container}`);
    await runCommand(runtime.ffmpegPath, videoArgs({
      input: material.path,
      output,
      video,
      audio: kept.audio,
      keepAudio: kept.keep,
    }), { timeoutMs: remainingMs(prepared.budget), signal: runtime.signal });
    return finish(prepared, output, container, checksumOf([material.bytes]), {
      container,
      durationMs: info.durationMs,
      durationToleranceMs,
      videoCodec: codec(prepared, video.encoder),
      audioCodec: kept.keep && kept.audio ? codec(prepared, kept.audio.encoder) : null,
      ...(video.width === undefined ? {} : { width: video.width }),
      ...(video.height === undefined ? {} : { height: video.height }),
      ...(video.fps === undefined ? {} : { fps: video.fps }),
    });
  });
}

export async function compressVideo(input: CompressVideoRequest): Promise<ProcessingResult> {
  const runtime = readRuntime(input);
  const source = readSingleSource(input.source);
  const container = readVideoContainer(input.container);
  if (input.videoEncoder === undefined) throw new StorageError('config_missing', 'videoEncoder is required');
  if (typeof input.videoEncoder !== 'string' || input.videoEncoder.length === 0) {
    throw new StorageError('config_invalid', 'videoEncoder is invalid');
  }
  const audio = readOptionalAudio(input.audio);
  const dropAudio = readDropAudio(input.dropAudio);
  const fps = readFps(input.fps);
  const width = readOptionalDimension(input.width, 'width');
  const height = readOptionalDimension(input.height, 'height');
  assertDimensions(width, height, 'compress');
  if (input.maxBytes === undefined) throw new StorageError('config_missing', 'maxBytes is required');
  if (typeof input.maxBytes !== 'number' || !Number.isInteger(input.maxBytes) || input.maxBytes <= 0) {
    throw new StorageError('config_invalid', 'maxBytes is invalid');
  }
  if (input.maxAttempts === undefined) throw new StorageError('config_missing', 'maxAttempts is required');
  if (typeof input.maxAttempts !== 'number' || !Number.isInteger(input.maxAttempts) || input.maxAttempts <= 0) {
    throw new StorageError('config_invalid', 'maxAttempts is invalid');
  }
  const durationToleranceMs = readTolerance(input.durationToleranceMs);
  assertAudioChoice(dropAudio, audio);
  if (runtime.signal.aborted) throw new StorageError('cancelled', 'operation cancelled');
  const prepared = await prepare(runtime, encoderList(input.videoEncoder, audio));
  return run(prepared, async () => {
    const material = await materialize(prepared, source, 'input.bin');
    const info = await probeFile(runtime.ffprobePath, material.path, prepared.budget);
    if (!info.video) throw new StorageError('config_invalid', 'input has no video track');
    if (info.durationMs <= 0) throw new StorageError('config_invalid', 'input duration is zero');
    const kept = keepAudio(info, dropAudio, audio);
    const audioBitrate = kept.audio?.bitrate ?? 0;
    const totalBitrate = Math.floor((input.maxBytes * 8) / (info.durationMs / 1000));
    let videoBitrate = totalBitrate - audioBitrate;
    if (videoBitrate < 1) {
      throw new StorageError('constraint_unsatisfied', 'target size is smaller than the encoded audio');
    }
    let smallest = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < input.maxAttempts; attempt += 1) {
      if (videoBitrate < 1) break;
      const output = workspaceFile(prepared.workspace, `attempt-${attempt}.${container}`);
      // Re-encode the original input. A previous attempt is never the next source, and -fs is not used.
      await runCommand(runtime.ffmpegPath, videoArgs({
        input: material.path,
        output,
        video: {
          encoder: input.videoEncoder,
          bitrate: videoBitrate,
          ...(fps === undefined ? {} : { fps }),
          ...(width === undefined ? {} : { width }),
          ...(height === undefined ? {} : { height }),
        },
        audio: kept.audio,
        keepAudio: kept.keep,
      }), { timeoutMs: remainingMs(prepared.budget), signal: runtime.signal });
      const size = await fileSize(output);
      smallest = Math.min(smallest, size);
      if (size > 0 && size <= input.maxBytes) {
        return finish(prepared, output, container, checksumOf([material.bytes]), {
          container,
          durationMs: info.durationMs,
          durationToleranceMs,
          videoCodec: codec(prepared, input.videoEncoder),
          audioCodec: kept.keep && kept.audio ? codec(prepared, kept.audio.encoder) : null,
          ...(width === undefined ? {} : { width }),
          ...(height === undefined ? {} : { height }),
          ...(fps === undefined ? {} : { fps }),
        });
      }
      if (size <= 0) break;
      const scaled = Math.floor(videoBitrate * (input.maxBytes / size) * 0.9);
      videoBitrate = scaled >= videoBitrate ? Math.floor(videoBitrate * 0.5) : scaled;
    }
    throw new StorageError(
      'constraint_unsatisfied',
      `target size ${input.maxBytes} bytes was not reached after ${input.maxAttempts} encodes (smallest ${Number.isFinite(smallest) ? smallest : 0})`,
    );
  });
}

export async function transcodeAudio(input: TranscodeAudioRequest): Promise<ProcessingResult> {
  return encodeAudio(input);
}

export async function extractAudio(input: TranscodeAudioRequest): Promise<ProcessingResult> {
  return encodeAudio(input);
}

export async function extractFrame(input: ExtractFrameRequest): Promise<ProcessingResult> {
  const runtime = readRuntime(input);
  const source = readSingleSource(input.source);
  if (input.imageEncoder === undefined) throw new StorageError('config_missing', 'imageEncoder is required');
  if (typeof input.imageEncoder !== 'string' || input.imageEncoder.length === 0) {
    throw new StorageError('config_invalid', 'imageEncoder is invalid');
  }
  if (input.atMs === undefined) throw new StorageError('config_missing', 'atMs is required');
  if (typeof input.atMs !== 'number' || !Number.isFinite(input.atMs) || input.atMs < 0) {
    throw new StorageError('config_invalid', 'atMs is invalid');
  }
  const width = readOptionalDimension(input.width, 'width');
  const height = readOptionalDimension(input.height, 'height');
  assertDimensions(width, height, 'frame');
  if (runtime.signal.aborted) throw new StorageError('cancelled', 'operation cancelled');
  const prepared = await prepare(runtime, [input.imageEncoder]);
  return run(prepared, async () => {
    const material = await materialize(prepared, source, 'input.bin');
    const info = await probeFile(runtime.ffprobePath, material.path, prepared.budget);
    if (!info.video) throw new StorageError('config_invalid', 'input has no video track');
    if (input.atMs >= info.durationMs && info.durationMs > 0) {
      throw new StorageError('config_invalid', 'atMs is outside the input duration');
    }
    const extension = input.imageEncoder === 'png' ? 'png' : 'frame';
    const output = workspaceFile(prepared.workspace, `frame.${extension}`);
    const args = ['-hide_banner', '-nostdin', '-y', '-i', material.path, '-ss', seconds(input.atMs), '-map', '0:v:0', '-frames:v', '1'];
    if (width !== undefined && height !== undefined) args.push('-vf', `scale=${width}:${height}`);
    args.push('-c:v', input.imageEncoder);
    if (input.imageEncoder === 'png') args.push('-update', '1');
    args.push(output);
    await runCommand(runtime.ffmpegPath, args, { timeoutMs: remainingMs(prepared.budget), signal: runtime.signal });
    const bytes = await readProduced(output);
    const probed = await probeFile(runtime.ffprobePath, output, prepared.budget);
    assertOutput(probed, {
      container: extension === 'png' ? 'png' : extension,
      videoCodec: codec(prepared, input.imageEncoder),
      audioCodec: null,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    });
    const mediaType = input.imageEncoder === 'png' ? 'image/png' : 'application/octet-stream';
    return publish(prepared.workspace, `frame.${extension}`, bytes, mediaType, checksumOf([material.bytes]));
  });
}

export async function trimMedia(input: TrimMediaRequest): Promise<TrimMediaResult> {
  const runtime = readRuntime(input);
  const source = readSingleSource(input.source);
  const container = readTrimContainer(input.container);
  const precision = readPrecision(input.precision);
  const video = readOptionalVideo(input.video);
  const audio = readOptionalAudio(input.audio);
  const dropAudio = readDropAudio(input.dropAudio);
  const durationToleranceMs = readTolerance(input.durationToleranceMs);
  if (input.startMs === undefined) throw new StorageError('config_missing', 'startMs is required');
  if (typeof input.startMs !== 'number' || !Number.isFinite(input.startMs) || input.startMs < 0) {
    throw new StorageError('config_invalid', 'startMs is invalid');
  }
  if (input.endMs === undefined) throw new StorageError('config_missing', 'endMs is required');
  if (typeof input.endMs !== 'number' || !Number.isFinite(input.endMs) || input.endMs <= input.startMs) {
    throw new StorageError('config_invalid', 'endMs is invalid');
  }
  assertAudioChoice(dropAudio, audio);
  if (runtime.signal.aborted) throw new StorageError('cancelled', 'operation cancelled');
  const encoders = precision === 'exact' ? encoderList(video?.encoder, audio) : [];
  const prepared = await prepare(runtime, encoders);
  return run(prepared, async () => {
    const material = await materialize(prepared, source, 'input.bin');
    const info = await probeFile(runtime.ffprobePath, material.path, prepared.budget);
    if (input.endMs > info.durationMs) throw new StorageError('config_invalid', 'trim range is outside the input duration');
    const output = workspaceFile(prepared.workspace, `output.${container}`);
    const expectedDuration = input.endMs - input.startMs;
    let expectation: MediaExpectation;
    if (precision === 'keyframe') {
      const args = [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-ss',
        seconds(input.startMs),
        '-i',
        material.path,
        '-t',
        seconds(expectedDuration),
      ];
      if (info.video) args.push('-map', '0:v:0');
      if (info.audio && !dropAudio) args.push('-map', '0:a:0');
      args.push('-c', 'copy', output);
      await runCommand(runtime.ffmpegPath, args, { timeoutMs: remainingMs(prepared.budget), signal: runtime.signal });
      expectation = {
        container,
        durationMs: expectedDuration,
        durationToleranceMs,
        videoCodec: info.video ? info.video.codec : null,
        audioCodec: info.audio && !dropAudio ? info.audio.codec : null,
      };
    } else {
      if (info.video && !video) throw new StorageError('config_missing', 'video settings are required for an exact trim');
      const kept = keepAudio(info, dropAudio, audio);
      if (!info.video && !kept.keep) throw new StorageError('config_invalid', 'input has no media track to trim');
      await runCommand(runtime.ffmpegPath, videoArgs({
        input: material.path,
        output,
        video,
        audio: kept.audio,
        keepAudio: kept.keep,
        videoOnly: info.video !== null,
        seek: { startMs: input.startMs, endMs: input.endMs },
      }), { timeoutMs: remainingMs(prepared.budget), signal: runtime.signal });
      expectation = {
        container,
        durationMs: expectedDuration,
        durationToleranceMs,
        videoCodec: info.video && video ? codec(prepared, video.encoder) : null,
        audioCodec: kept.keep && kept.audio ? codec(prepared, kept.audio.encoder) : null,
        ...(video?.width === undefined ? {} : { width: video.width }),
        ...(video?.height === undefined ? {} : { height: video.height }),
        ...(video?.fps === undefined ? {} : { fps: video.fps }),
      };
    }
    const result = await finish(prepared, output, container, checksumOf([material.bytes]), expectation);
    return {
      ...result,
      precision,
      frameAccurate: precision === 'exact',
    };
  });
}

export async function concatMedia(input: ConcatMediaRequest): Promise<ProcessingResult> {
  const runtime = readRuntime(input);
  const sources = readConcatSources(input.sources);
  const container = readVideoContainer(input.container);
  const allowNormalize = readAllowNormalize(input.allowNormalize);
  const video = readOptionalVideo(input.video);
  const audio = readOptionalAudio(input.audio);
  const dropAudio = readDropAudio(input.dropAudio);
  const durationToleranceMs = readTolerance(input.durationToleranceMs);
  assertAudioChoice(dropAudio, audio);
  if (runtime.signal.aborted) throw new StorageError('cancelled', 'operation cancelled');
  const encoders = allowNormalize ? encoderList(video?.encoder, audio) : [];
  const prepared = await prepare(runtime, encoders);
  return run(prepared, async () => {
    const materials: Material[] = [];
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index];
      if (!source) throw new StorageError('config_invalid', 'sources is invalid');
      materials.push(await materialize(prepared, source, `input-${index}.bin`));
    }
    const infos: MediaInfo[] = [];
    for (const material of materials) {
      infos.push(await probeFile(runtime.ffprobePath, material.path, prepared.budget));
    }
    const first = infos[0];
    if (!first) throw new StorageError('config_invalid', 'sources is invalid');
    if (infos.some((info) => !info.video)) throw new StorageError('config_invalid', 'concat input has no video track');
    const compatible = infos.every((info) => sameStreams(info, first));
    const output = workspaceFile(prepared.workspace, `output.${container}`);
    const expectedDuration = infos.reduce((sum, info) => sum + info.durationMs, 0);
    if (compatible && (!allowNormalize || !video)) {
      const list = materials.map((material) => concatLine(material.path)).join('\n');
      const listPath = await writeWorkspaceText(prepared.workspace, 'concat.txt', `${list}\n`);
      const args = ['-hide_banner', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', listPath];
      if (dropAudio) args.push('-map', '0:v:0');
      args.push('-c', 'copy', output);
      await runCommand(runtime.ffmpegPath, args, { timeoutMs: remainingMs(prepared.budget), signal: runtime.signal });
      return finish(prepared, output, container, checksumOf(materials.map((material) => material.bytes)), {
        container,
        durationMs: expectedDuration,
        durationToleranceMs,
        videoCodec: first.video?.codec ?? null,
        audioCodec: !dropAudio && first.audio ? first.audio.codec : null,
      });
    }
    if (!allowNormalize) {
      throw new StorageError('config_invalid', 'encodings are incompatible unless allowNormalize is true');
    }
    if (!video) throw new StorageError('config_missing', 'video settings are required to normalize');
    const mismatchedSize = infos.some((info) => info.video?.width !== first.video?.width || info.video?.height !== first.video?.height);
    const mismatchedFps = infos.some((info) => Math.abs((info.video?.fps ?? 0) - (first.video?.fps ?? 0)) > 0.01);
    if (mismatchedSize && (video.width === undefined || video.height === undefined)) {
      throw new StorageError('config_missing', 'width and height are required to normalize mismatched frame sizes');
    }
    if (mismatchedFps && video.fps === undefined) {
      throw new StorageError('config_missing', 'fps is required to normalize mismatched frame rates');
    }
    const audioPresence = infos.map((info) => info.audio !== null);
    const mixedAudio = audioPresence.some((present) => present !== audioPresence[0]);
    if (mixedAudio && !dropAudio) throw new StorageError('config_invalid', 'concat inputs do not agree on audio');
    const wantAudio = !dropAudio && audioPresence[0] === true;
    if (wantAudio && !audio) throw new StorageError('config_missing', 'audio settings are required to normalize');
    const mismatchedRate = wantAudio && infos.some((info) => info.audio?.sampleRate !== first.audio?.sampleRate);
    if (mismatchedRate && audio?.sampleRate === undefined) {
      throw new StorageError('config_missing', 'audio.sampleRate is required to normalize mismatched sample rates');
    }
    const mismatchedChannels = wantAudio && infos.some((info) => info.audio?.channels !== first.audio?.channels);
    if (mismatchedChannels) throw new StorageError('config_invalid', 'concat inputs use different channel layouts');
    const args = ['-hide_banner', '-nostdin', '-y'];
    for (const material of materials) args.push('-i', material.path);
    args.push('-filter_complex', normalizeFilter(materials.length, video, wantAudio ? audio ?? null : null));
    args.push('-map', '[v]');
    if (wantAudio) args.push('-map', '[a]');
    args.push('-c:v', video.encoder, '-b:v', String(video.bitrate), '-pix_fmt', 'yuv420p');
    if (video.fps !== undefined) args.push('-r', String(video.fps));
    if (wantAudio && audio) args.push('-c:a', audio.encoder, '-b:a', String(audio.bitrate));
    args.push(output);
    await runCommand(runtime.ffmpegPath, args, { timeoutMs: remainingMs(prepared.budget), signal: runtime.signal });
    return finish(prepared, output, container, checksumOf(materials.map((material) => material.bytes)), {
      container,
      durationMs: expectedDuration,
      durationToleranceMs,
      videoCodec: codec(prepared, video.encoder),
      audioCodec: wantAudio && audio ? codec(prepared, audio.encoder) : null,
      ...(video.width === undefined ? {} : { width: video.width }),
      ...(video.height === undefined ? {} : { height: video.height }),
      ...(video.fps === undefined ? {} : { fps: video.fps }),
      ...(wantAudio && audio?.sampleRate !== undefined ? { sampleRate: audio.sampleRate } : {}),
    });
  });
}

async function encodeAudio(input: TranscodeAudioRequest): Promise<ProcessingResult> {
  const runtime = readRuntime(input);
  const source = readSingleSource(input.source);
  const container = readAudioContainer(input.container);
  const audio = readAudioSettings(input.audio);
  const durationToleranceMs = readTolerance(input.durationToleranceMs);
  if (runtime.signal.aborted) throw new StorageError('cancelled', 'operation cancelled');
  const prepared = await prepare(runtime, [audio.encoder]);
  return run(prepared, async () => {
    const material = await materialize(prepared, source, 'input.bin');
    const info = await probeFile(runtime.ffprobePath, material.path, prepared.budget);
    if (!info.audio) throw new StorageError('config_invalid', 'input has no audio track');
    const output = workspaceFile(prepared.workspace, `output.${container}`);
    const args = [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-i',
      material.path,
      '-vn',
      '-c:a',
      audio.encoder,
      '-b:a',
      String(audio.bitrate),
    ];
    if (audio.sampleRate !== undefined) args.push('-ar', String(audio.sampleRate));
    args.push(output);
    await runCommand(runtime.ffmpegPath, args, { timeoutMs: remainingMs(prepared.budget), signal: runtime.signal });
    return finish(prepared, output, container, checksumOf([material.bytes]), {
      container,
      durationMs: info.durationMs,
      durationToleranceMs,
      videoCodec: null,
      audioCodec: codec(prepared, audio.encoder),
      ...(audio.sampleRate === undefined ? {} : { sampleRate: audio.sampleRate }),
    });
  });
}

function videoArgs(options: {
  input: string;
  output: string;
  video: VideoSettings | undefined;
  audio: AudioSettings | null;
  keepAudio: boolean;
  videoOnly?: boolean;
  seek?: { startMs: number; endMs: number };
}): string[] {
  const args = ['-hide_banner', '-nostdin', '-y', '-i', options.input];
  if (options.seek) args.push('-ss', seconds(options.seek.startMs), '-to', seconds(options.seek.endMs));
  const includeVideo = options.videoOnly !== false && options.video !== undefined;
  if (includeVideo && options.video) {
    args.push('-map', '0:v:0', '-c:v', options.video.encoder, '-b:v', String(options.video.bitrate));
    if (options.video.width !== undefined && options.video.height !== undefined) {
      args.push('-vf', `scale=${options.video.width}:${options.video.height}`);
    }
    if (options.video.fps !== undefined) args.push('-r', String(options.video.fps));
    if (options.video.encoder === 'libx264' || options.video.encoder === 'libx264rgb' || options.video.encoder === 'mpeg4') {
      args.push('-pix_fmt', 'yuv420p');
    }
  }
  if (options.keepAudio && options.audio) {
    args.push('-map', '0:a:0', '-c:a', options.audio.encoder, '-b:a', String(options.audio.bitrate));
    if (options.audio.sampleRate !== undefined) args.push('-ar', String(options.audio.sampleRate));
  } else if (includeVideo) {
    args.push('-an');
  }
  args.push(options.output);
  return args;
}

function normalizeFilter(count: number, video: VideoSettings, audio: AudioSettings | null): string {
  const chains: string[] = [];
  const labels: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const filters: string[] = [];
    if (video.width !== undefined && video.height !== undefined) filters.push(`scale=${video.width}:${video.height}`);
    if (video.fps !== undefined) filters.push(`fps=${video.fps}`);
    if (filters.length === 0) labels.push(`[${index}:v]`);
    else {
      chains.push(`[${index}:v]${filters.join(',')}[v${index}]`);
      labels.push(`[v${index}]`);
    }
    if (audio) {
      if (audio.sampleRate !== undefined) {
        chains.push(`[${index}:a]aformat=sample_rates=${audio.sampleRate}[a${index}]`);
        labels.push(`[a${index}]`);
      } else labels.push(`[${index}:a]`);
    }
  }
  chains.push(`${labels.join('')}concat=n=${count}:v=1:a=${audio ? 1 : 0}[v]${audio ? '[a]' : ''}`);
  return chains.join(';');
}

function concatLine(filePath: string): string {
  if (filePath.includes('\n') || filePath.includes('\r')) {
    throw new StorageError('config_invalid', 'media path cannot contain a newline');
  }
  return `file '${filePath.replace(/'/g, `'\\''`)}'`;
}

function keepAudio(
  info: MediaInfo,
  dropAudio: boolean,
  audio: AudioSettings | undefined,
): { keep: boolean; audio: AudioSettings | null } {
  if (dropAudio) return { keep: false, audio: null };
  if (!info.audio) {
    if (audio) throw new StorageError('config_invalid', 'input has no audio track');
    return { keep: false, audio: null };
  }
  if (!audio) throw new StorageError('config_missing', 'audio settings are required to keep the input audio track');
  return { keep: true, audio };
}

function encoderList(videoEncoder: string | undefined, audio: AudioSettings | undefined): string[] {
  const encoders: string[] = [];
  if (videoEncoder) encoders.push(videoEncoder);
  if (audio) encoders.push(audio.encoder);
  return encoders;
}

function codec(prepared: Prepared, encoder: string): string {
  const mapped = outputCodec(encoder, prepared.hints);
  if (!mapped) throw new StorageError('config_invalid', `encoder cannot be verified: ${encoder}`);
  return mapped;
}

async function finish(
  prepared: Prepared,
  output: string,
  container: string,
  inputChecksum: ReturnType<typeof checksumOf>,
  expected: MediaExpectation,
): Promise<ProcessingResult> {
  const probed = await probeFile(prepared.runtime.ffprobePath, output, prepared.budget);
  assertOutput(probed, expected);
  const bytes = await readProduced(output);
  return publish(prepared.workspace, `output.${container}`, bytes, mediaTypeFor(container), inputChecksum);
}

async function run<T>(prepared: Prepared, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await discard(prepared);
    throw error;
  }
}

function readFps(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new StorageError('config_invalid', 'fps is invalid');
  }
  return value;
}
