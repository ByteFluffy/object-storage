import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { transcodeAudio, type TranscodeAudioRequest } from '../../src/plugins/media/index.js';

describe('transcodeAudio', () => {
  it('builds an audio-only encode from the caller bitrate', async () => {
    const ctx = await fakeContext();
    const restore = useFakeEnv({
      MEDIA_FAKE_LOG: ctx.log,
      MEDIA_FAKE_PROBE: probeDocument({ audio: true }),
    });
    try {
      const result = await transcodeAudio(audioRequest(ctx));
      const args = encodeArgs(ctx.log);
      expect(args).toContain('-vn');
      expect(pair(args, '-c:a')).toBe('libmp3lame');
      expect(pair(args, '-b:a')).toBe('64000');
      expect(args).not.toContain('libx264');
      expect(args).not.toContain('-fs');
      expect(result.artifact.mediaType).toBe('audio/mpeg');
      await result.artifact.release();
    } finally {
      restore();
    }
  });

  it('rejects a missing bitrate before the stream is pulled', async () => {
    const ctx = await fakeContext();
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    }, { highWaterMark: 0 });
    try {
      await expect(transcodeAudio(audioRequest(ctx, {
        source: { kind: 'stream', stream },
        audio: { encoder: 'libmp3lame' },
      }))).rejects.toMatchObject({ code: 'config_missing' });
      expect(pulled).toBe(false);
    } finally {
      // no fake env
    }
  });

  it('rejects an input that has no audio track', async () => {
    const ctx = await fakeContext();
    const restore = useFakeEnv({
      MEDIA_FAKE_LOG: ctx.log,
      MEDIA_FAKE_PROBE: probeDocument({ audio: false }),
    });
    try {
      await expect(transcodeAudio(audioRequest(ctx))).rejects.toMatchObject({ code: 'config_invalid' });
      expect(encodeArgs(ctx.log)).toEqual([]);
    } finally {
      restore();
    }
  });

  it('rejects an output duration outside the caller tolerance', async () => {
    const ctx = await fakeContext();
    await writeFile(ctx.probes, JSON.stringify([
      JSON.parse(probeDocument({ audio: true, duration: '1.000000' })),
      JSON.parse(probeDocument({ audio: true, duration: '4.000000', format: 'mp3' })),
    ]));
    const restore = useFakeEnv({ MEDIA_FAKE_LOG: ctx.log, MEDIA_FAKE_PROBES: ctx.probes });
    try {
      await expect(transcodeAudio(audioRequest(ctx))).rejects.toMatchObject({ code: 'constraint_unsatisfied' });
    } finally {
      restore();
    }
  });
});

type Context = { dir: string; ffmpegPath: string; ffprobePath: string; source: string; log: string; probes: string };

async function fakeContext(): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'media-audio-'));
  const ffmpegPath = join(dir, 'ffmpeg');
  const ffprobePath = join(dir, 'ffprobe');
  await writeFile(ffmpegPath, FAKE_TOOL);
  await writeFile(ffprobePath, FAKE_TOOL);
  await chmod(ffmpegPath, 0o755);
  await chmod(ffprobePath, 0o755);
  const source = join(dir, 'clip.bin');
  await writeFile(source, 'input-bytes');
  return { dir, ffmpegPath, ffprobePath, source, log: join(dir, 'calls.log'), probes: join(dir, 'probes.json') };
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

function probeDocument(options: { audio: boolean; duration?: string; format?: string }): string {
  const duration = options.duration ?? '1.000000';
  const streams: Record<string, unknown>[] = [];
  if (options.audio) {
    streams.push({ codec_type: 'audio', codec_name: 'mp3', sample_rate: '44100', channels: 1, duration });
  }
  return JSON.stringify({
    format: { format_name: options.format ?? 'mp3', duration },
    streams,
  });
}

const FAKE_TOOL = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (process.env.MEDIA_FAKE_LOG) appendFileSync(process.env.MEDIA_FAKE_LOG, JSON.stringify(args) + '\\n');
if (args.includes('-encoders')) {
  process.stdout.write(' A..... libmp3lame encoder (codec mp3)\\n');
  process.stdout.write(' A..... aac encoder (codec aac)\\n');
  process.exit(0);
}
if (args.includes('-print_format')) {
  const queuePath = process.env.MEDIA_FAKE_PROBES;
  let payload = process.env.MEDIA_FAKE_PROBE || '{}';
  if (queuePath) {
    const queue = JSON.parse(readFileSync(queuePath, 'utf8'));
    payload = JSON.stringify(queue.shift());
    writeFileSync(queuePath, JSON.stringify(queue));
  }
  process.stdout.write(payload);
  process.exit(0);
}
writeFileSync(args[args.length - 1], Buffer.alloc(16, 2));
process.exit(0);
`;
