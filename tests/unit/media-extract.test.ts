import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractAudio, extractFrame, type ExtractFrameRequest, type TranscodeAudioRequest } from '../../src/plugins/media/index.js';

describe('extractAudio', () => {
  it('removes video and encodes the audio track with the caller settings', async () => {
    const ctx = await fakeContext();
    const restore = useFakeEnv({ MEDIA_FAKE_LOG: ctx.log, MEDIA_FAKE_PROBE: audioProbe(true) });
    try {
      const result = await extractAudio(audioRequest(ctx));
      const args = encodeArgs(ctx.log);
      expect(args).toContain('-vn');
      expect(pair(args, '-c:a')).toBe('libmp3lame');
      expect(pair(args, '-b:a')).toBe('64000');
      expect(args).not.toContain('-c:v');
      expect(result.artifact.mediaType).toBe('audio/mpeg');
      await result.artifact.release();
    } finally {
      restore();
    }
  });

  it('rejects extraction when the input has no audio track', async () => {
    const ctx = await fakeContext();
    const restore = useFakeEnv({ MEDIA_FAKE_LOG: ctx.log, MEDIA_FAKE_PROBE: audioProbe(false) });
    try {
      await expect(extractAudio(audioRequest(ctx))).rejects.toMatchObject({ code: 'config_invalid' });
      expect(encodeArgs(ctx.log)).toEqual([]);
    } finally {
      restore();
    }
  });
});

describe('extractFrame', () => {
  it('rejects a missing png encoder before the stream is pulled', async () => {
    const ctx = await fakeContext();
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const restore = useFakeEnv({ MEDIA_FAKE_ENCODERS: 'libx264 aac', MEDIA_FAKE_LOG: ctx.log });
    try {
      await expect(extractFrame(frameRequest(ctx, { source: { kind: 'stream', stream } }))).rejects.toMatchObject({
        code: 'capability_unsupported',
      });
      expect(pulled).toBe(false);
    } finally {
      restore();
    }
  });

  it('extracts one png frame without scaling unless the caller asks', async () => {
    const ctx = await fakeContext();
    const restore = useFakeEnv({ MEDIA_FAKE_LOG: ctx.log, MEDIA_FAKE_PROBE: frameProbe() });
    try {
      const result = await extractFrame(frameRequest(ctx));
      const args = encodeArgs(ctx.log);
      expect(pair(args, '-frames:v')).toBe('1');
      expect(pair(args, '-c:v')).toBe('png');
      expect(pair(args, '-ss')).toBe('0.100');
      expect(args.indexOf('-ss')).toBeGreaterThan(args.indexOf('-i'));
      expect(args).not.toContain('-vf');
      expect(args).toContain('-update');
      expect(result.artifact.mediaType).toBe('image/png');
      await result.artifact.release();
    } finally {
      restore();
    }
  });

  it('rejects a timestamp outside the input duration', async () => {
    const ctx = await fakeContext();
    const restore = useFakeEnv({ MEDIA_FAKE_LOG: ctx.log, MEDIA_FAKE_PROBE: frameProbe() });
    try {
      await expect(extractFrame(frameRequest(ctx, { atMs: 5000 }))).rejects.toMatchObject({ code: 'config_invalid' });
      expect(encodeArgs(ctx.log)).toEqual([]);
    } finally {
      restore();
    }
  });
});

type Context = { dir: string; ffmpegPath: string; ffprobePath: string; source: string; log: string };

async function fakeContext(): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'media-extract-'));
  const ffmpegPath = join(dir, 'ffmpeg');
  const ffprobePath = join(dir, 'ffprobe');
  await writeFile(ffmpegPath, FAKE_TOOL);
  await writeFile(ffprobePath, FAKE_TOOL);
  await chmod(ffmpegPath, 0o755);
  await chmod(ffprobePath, 0o755);
  const source = join(dir, 'clip.bin');
  await writeFile(source, 'input-bytes');
  return { dir, ffmpegPath, ffprobePath, source, log: join(dir, 'calls.log') };
}

function audioRequest(ctx: Context, overrides: Record<string, unknown> = {}): TranscodeAudioRequest {
  return {
    source: { kind: 'file', path: ctx.source },
    ffmpegPath: ctx.ffmpegPath,
    ffprobePath: ctx.ffprobePath,
    workspaceDirectory: ctx.dir,
    deadlineMs: 5000,
    signal: new AbortController().signal,
    container: 'mp3',
    audio: { encoder: 'libmp3lame', bitrate: 64000 },
    durationToleranceMs: 50,
    ...overrides,
  } as TranscodeAudioRequest;
}

function frameRequest(ctx: Context, overrides: Record<string, unknown> = {}): ExtractFrameRequest {
  return {
    source: { kind: 'file', path: ctx.source },
    ffmpegPath: ctx.ffmpegPath,
    ffprobePath: ctx.ffprobePath,
    workspaceDirectory: ctx.dir,
    deadlineMs: 5000,
    signal: new AbortController().signal,
    imageEncoder: 'png',
    atMs: 100,
    ...overrides,
  } as ExtractFrameRequest;
}

function encodeArgs(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  const calls = readFileSync(logPath, 'utf8').split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as string[]);
  return calls.find((args) => args.includes('-i') && !args.includes('-print_format')) ?? [];
}

function pair(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function useFakeEnv(values: Record<string, string>): () => void {
  const keys = Object.keys(values);
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  return () => {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function audioProbe(hasAudio: boolean): string {
  const streams = hasAudio
    ? [{ codec_type: 'audio', codec_name: 'mp3', sample_rate: '44100', channels: 1, duration: '1.000000' }]
    : [{ codec_type: 'video', codec_name: 'h264', width: 160, height: 120, r_frame_rate: '10/1', duration: '1.000000' }];
  return JSON.stringify({ format: { format_name: hasAudio ? 'mp3' : 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1.000000' }, streams });
}

function frameProbe(): string {
  return JSON.stringify({
    format: { format_name: 'png_pipe', duration: '1.000000' },
    streams: [{ codec_type: 'video', codec_name: 'png', width: 160, height: 120, r_frame_rate: '10/1', duration: '1.000000' }],
  });
}

const FAKE_TOOL = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (process.env.MEDIA_FAKE_LOG) appendFileSync(process.env.MEDIA_FAKE_LOG, JSON.stringify(args) + '\\n');
if (args.includes('-encoders')) {
  const names = (process.env.MEDIA_FAKE_ENCODERS || 'libx264 aac libmp3lame png').split(/\\s+/).filter(Boolean);
  for (const name of names) {
    const kind = name === 'aac' || name === 'libmp3lame' ? 'A' : 'V';
    const codec = name === 'libx264' ? 'h264' : name === 'libmp3lame' ? 'mp3' : name;
    process.stdout.write(' ' + kind + '..... ' + name + ' encoder (codec ' + codec + ')\\n');
  }
  process.exit(0);
}
if (args.includes('-print_format')) {
  process.stdout.write(process.env.MEDIA_FAKE_PROBE || '{}');
  process.exit(0);
}
writeFileSync(args[args.length - 1], Buffer.alloc(12, 5));
process.exit(0);
`;
