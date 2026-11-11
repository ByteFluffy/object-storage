import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compressVideo,
  transcodeVideo,
  trimMedia,
  type CompressVideoRequest,
  type TranscodeVideoRequest,
  type TrimMediaRequest,
} from '../../src/plugins/media/index.js';

describe('transcodeVideo', () => {
  it('keeps an audio track and does not invent a frame size or rate', async () => {
    const ctx = await fakeContext();
    const restore = useFakeEnv({
      MEDIA_FAKE_LOG: ctx.log,
      MEDIA_FAKE_PROBE: probeDocument({ audio: {} }),
    });
    try {
      const result = await transcodeVideo(transcodeRequest(ctx));
      const args = encodeArgs(ctx.log);
      expect(args).toContain('-c:v');
      expect(args).toContain('libx264');
      expect(pair(args, '-b:v')).toBe('100000');
      expect(pair(args, '-c:a')).toBe('aac');
      expect(pair(args, '-b:a')).toBe('48000');
      expect(args).not.toContain('-an');
      expect(args).not.toContain('-r');
      expect(args).not.toContain('-vf');
      expect(args).not.toContain('1920');
      expect(args).not.toContain('1080');
      expect(args).not.toContain('-fs');
      expect(args[args.length - 1]).toMatch(/\.mp4$/);
      expect(result.artifact.mediaType).toBe('video/mp4');
      expect(result.outputChecksum).toEqual(result.artifact.checksum);
      const output = await result.artifact.read();
      expect(output).toEqual(new Uint8Array(24).fill(3));
      expect(result.inputChecksum).toEqual({
        algorithm: 'sha256',
        value: createHash('sha256').update('input-bytes').digest('hex'),
      });
      await result.artifact.release();
      expect(await readFile(ctx.source, 'utf8')).toBe('input-bytes');
    } finally {
      restore();
    }
  });

  it('drops audio only when dropAudio is true', async () => {
    const ctx = await fakeContext();
    await writeFile(ctx.probes, JSON.stringify([
      JSON.parse(probeDocument({ audio: {} })),
      JSON.parse(probeDocument({ audio: null })),
    ]));
    const restore = useFakeEnv({ MEDIA_FAKE_LOG: ctx.log, MEDIA_FAKE_PROBES: ctx.probes });
    try {
      await transcodeVideo(transcodeRequest(ctx, { audio: undefined, dropAudio: true }));
      const args = encodeArgs(ctx.log);
      expect(args).toContain('-an');
      expect(args).not.toContain('-c:a');
    } finally {
      restore();
    }
  });

  it('rejects an audio request when the input has no audio track', async () => {
    const ctx = await fakeContext();
    const restore = useFakeEnv({
      MEDIA_FAKE_LOG: ctx.log,
      MEDIA_FAKE_PROBE: probeDocument({ audio: null }),
    });
    try {
      await expect(transcodeVideo(transcodeRequest(ctx))).rejects.toMatchObject({ code: 'config_invalid' });
      expect(encodeArgs(ctx.log)).toEqual([]);
    } finally {
      restore();
    }
  });

  it('requires audio settings when the input has audio and audio is not dropped', async () => {
    const ctx = await fakeContext();
    const restore = useFakeEnv({ MEDIA_FAKE_LOG: ctx.log, MEDIA_FAKE_PROBE: probeDocument({ audio: {} }) });
    try {
      await expect(transcodeVideo(transcodeRequest(ctx, { audio: undefined }))).rejects.toMatchObject({
        code: 'config_missing',
      });
      expect(encodeArgs(ctx.log)).toEqual([]);
    } finally {
      restore();
    }
  });

  it('rejects a duration outside the caller tolerance', async () => {
    const ctx = await fakeContext();
    await writeFile(ctx.probes, JSON.stringify([
      JSON.parse(probeDocument({ audio: {}, duration: '1.000000' })),
      JSON.parse(probeDocument({ audio: {}, duration: '9.000000' })),
    ]));
    const restore = useFakeEnv({ MEDIA_FAKE_LOG: ctx.log, MEDIA_FAKE_PROBES: ctx.probes });
    try {
      await expect(transcodeVideo(transcodeRequest(ctx))).rejects.toMatchObject({ code: 'constraint_unsatisfied' });
      expect(await readFile(ctx.source, 'utf8')).toBe('input-bytes');
    } finally {
      restore();
    }
  });

  it('passes caller fps and frame size through as discrete arguments', async () => {
    const ctx = await fakeContext();
    await writeFile(ctx.probes, JSON.stringify([
      JSON.parse(probeDocument({ audio: {} })),
      JSON.parse(probeDocument({ audio: {}, width: 80, height: 60, fps: '12/1' })),
    ]));
    const restore = useFakeEnv({ MEDIA_FAKE_LOG: ctx.log, MEDIA_FAKE_PROBES: ctx.probes });
    try {
      await transcodeVideo(transcodeRequest(ctx, {
        video: { encoder: 'libx264', bitrate: 100000, fps: 12, width: 80, height: 60 },
      }));
      const args = encodeArgs(ctx.log);
      expect(pair(args, '-r')).toBe('12');
      expect(pair(args, '-vf')).toBe('scale=80:60');
    } finally {
      restore();
    }
  });
});

describe('compressVideo', () => {
  it('re-encodes each attempt from the original input and never uses -fs', async () => {
    const ctx = await fakeContext();
    const restore = useFakeEnv({
      MEDIA_FAKE_LOG: ctx.log,
      MEDIA_FAKE_MODE: 'shrink',
      MEDIA_FAKE_COUNT: ctx.count,
      MEDIA_FAKE_LARGE: '5000',
      MEDIA_FAKE_SMALL: '80',
      MEDIA_FAKE_SHRINK_AT: '2',
      MEDIA_FAKE_PROBE: probeDocument({ audio: {} }),
    });
    try {
      const result = await compressVideo(compressRequest(ctx, { maxBytes: 1000, maxAttempts: 3 }));
      const encodes = encodeCalls(ctx.log);
      expect(encodes).toHaveLength(2);
      const first = encodes[0];
      const second = encodes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;
      expect(pair(first, '-i')).toBe(ctx.source);
      expect(pair(second, '-i')).toBe(ctx.source);
      expect(pair(second, '-i')).not.toBe(first[first.length - 1]);
      const firstRate = Number(pair(first, '-b:v'));
      const secondRate = Number(pair(second, '-b:v'));
      expect(secondRate).toBeLessThan(firstRate);
      expect(firstRate).toBeGreaterThan(0);
      expect(encodes.flat()).not.toContain('-fs');
      expect(result.artifact.byteLength).toBeLessThanOrEqual(1000);
      await result.artifact.release();
      expect(await readFile(ctx.source, 'utf8')).toBe('input-bytes');
    } finally {
      restore();
    }
  });

  it('stops after the finite attempt budget when the target stays out of reach', async () => {
    const ctx = await fakeContext();
    const restore = useFakeEnv({
      MEDIA_FAKE_LOG: ctx.log,
      MEDIA_FAKE_OUT_BYTES: '5000',
      MEDIA_FAKE_PROBE: probeDocument({ audio: null }),
    });
    try {
      await expect(compressVideo(compressRequest(ctx, {
        audio: undefined,
        dropAudio: true,
        maxBytes: 1000,
        maxAttempts: 2,
      }))).rejects.toMatchObject({ code: 'constraint_unsatisfied' });
      const encodes = encodeCalls(ctx.log);
      expect(encodes).toHaveLength(2);
      expect(encodes.every((args) => pair(args, '-i') === ctx.source)).toBe(true);
      expect(encodes.flat()).not.toContain('-fs');
    } finally {
      restore();
    }
  });

  it('fails before encoding when audio alone cannot fit the target', async () => {
    const ctx = await fakeContext();
    const restore = useFakeEnv({ MEDIA_FAKE_LOG: ctx.log, MEDIA_FAKE_PROBE: probeDocument({ audio: {} }) });
    try {
      await expect(compressVideo(compressRequest(ctx, {
        maxBytes: 100,
        maxAttempts: 3,
        audio: { encoder: 'aac', bitrate: 1_000_000 },
      }))).rejects.toMatchObject({ code: 'constraint_unsatisfied' });
      expect(encodeCalls(ctx.log)).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('shares one deadline across encode attempts', async () => {
    const ctx = await fakeContext();
    const restore = useFakeEnv({
      MEDIA_FAKE_LOG: ctx.log,
      MEDIA_FAKE_MODE: 'delay-huge',
      MEDIA_FAKE_DELAY_MS: '250',
      MEDIA_FAKE_OUT_BYTES: '4000',
      MEDIA_FAKE_PROBE: probeDocument({ audio: null }),
    });
    const started = Date.now();
    try {
      await expect(compressVideo(compressRequest(ctx, {
        audio: undefined,
        dropAudio: true,
        maxBytes: 3000,
        maxAttempts: 6,
        deadlineMs: 700,
      }))).rejects.toMatchObject({ code: 'cancelled' });
      expect(Date.now() - started).toBeLessThan(1200);
      expect(encodeCalls(ctx.log).length).toBeGreaterThan(0);
      expect(encodeCalls(ctx.log).length).toBeLessThan(6);
    } finally {
      restore();
    }
  });
});

describe('trimMedia', () => {
  it('does not label a keyframe trim as frame accurate', async () => {
    const ctx = await fakeContext();
    await writeFile(ctx.probes, JSON.stringify([
      JSON.parse(probeDocument({ audio: {}, duration: '1.000000' })),
      JSON.parse(probeDocument({ audio: {}, duration: '0.600000' })),
    ]));
    const restore = useFakeEnv({ MEDIA_FAKE_LOG: ctx.log, MEDIA_FAKE_PROBES: ctx.probes });
    try {
      const result = await trimMedia(trimRequest(ctx, { precision: 'keyframe' }));
      const args = encodeArgs(ctx.log);
      expect(result.precision).toBe('keyframe');
      expect(result.frameAccurate).toBe(false);
      expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
      expect(pair(args, '-c')).toBe('copy');
      expect(args).not.toContain('libx264');
      await result.artifact.release();
    } finally {
      restore();
    }
  });

  it('re-encodes an exact trim and marks it frame accurate', async () => {
    const ctx = await fakeContext();
    await writeFile(ctx.probes, JSON.stringify([
      JSON.parse(probeDocument({ audio: {}, duration: '1.000000' })),
      JSON.parse(probeDocument({ audio: {}, duration: '0.600000' })),
    ]));
    const restore = useFakeEnv({ MEDIA_FAKE_LOG: ctx.log, MEDIA_FAKE_PROBES: ctx.probes });
    try {
      const result = await trimMedia(trimRequest(ctx, {
        precision: 'exact',
        video: { encoder: 'libx264', bitrate: 100000 },
        audio: { encoder: 'aac', bitrate: 48000 },
      }));
      const args = encodeArgs(ctx.log);
      expect(result.precision).toBe('exact');
      expect(result.frameAccurate).toBe(true);
      expect(args.indexOf('-ss')).toBeGreaterThan(args.indexOf('-i'));
      expect(pair(args, '-to')).toBe('0.800');
      expect(args).toContain('libx264');
      expect(pair(args, '-c')).not.toBe('copy');
      await result.artifact.release();
    } finally {
      restore();
    }
  });

  it('requires encode settings for an exact trim after the input is known to have video', async () => {
    const ctx = await fakeContext();
    const restore = useFakeEnv({ MEDIA_FAKE_LOG: ctx.log, MEDIA_FAKE_PROBE: probeDocument({ audio: null }) });
    try {
      await expect(trimMedia(trimRequest(ctx, { precision: 'exact' }))).rejects.toMatchObject({
        code: 'config_missing',
      });
      expect(encodeCalls(ctx.log)).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

type Context = {
  dir: string;
  ffmpegPath: string;
  ffprobePath: string;
  source: string;
  log: string;
  probes: string;
  count: string;
};

async function fakeContext(): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'media-video-'));
  const ffmpegPath = join(dir, 'ffmpeg');
  const ffprobePath = join(dir, 'ffprobe');
  await writeFile(ffmpegPath, FAKE_TOOL);
  await writeFile(ffprobePath, FAKE_TOOL);
  await chmod(ffmpegPath, 0o755);
  await chmod(ffprobePath, 0o755);
  const source = join(dir, 'clip.bin');
  await writeFile(source, 'input-bytes');
  return {
    dir,
    ffmpegPath,
    ffprobePath,
    source,
    log: join(dir, 'calls.log'),
    probes: join(dir, 'probes.json'),
    count: join(dir, 'count'),
  };
}

function transcodeRequest(ctx: Context, overrides: Record<string, unknown> = {}): TranscodeVideoRequest {
  return {
    source: { kind: 'file', path: ctx.source },
    ffmpegPath: ctx.ffmpegPath,
    ffprobePath: ctx.ffprobePath,
    workspaceDirectory: ctx.dir,
    deadlineMs: 5000,
    signal: new AbortController().signal,
    container: 'mp4',
    video: { encoder: 'libx264', bitrate: 100000 },
    audio: { encoder: 'aac', bitrate: 48000 },
    durationToleranceMs: 50,
    ...overrides,
  } as TranscodeVideoRequest;
}

function compressRequest(ctx: Context, overrides: Record<string, unknown> = {}): CompressVideoRequest {
  return {
    source: { kind: 'file', path: ctx.source },
    ffmpegPath: ctx.ffmpegPath,
    ffprobePath: ctx.ffprobePath,
    workspaceDirectory: ctx.dir,
    deadlineMs: 5000,
    signal: new AbortController().signal,
    container: 'mp4',
    videoEncoder: 'libx264',
    audio: { encoder: 'aac', bitrate: 1000 },
    maxBytes: 1000,
    maxAttempts: 2,
    durationToleranceMs: 50,
    ...overrides,
  } as CompressVideoRequest;
}

function trimRequest(ctx: Context, overrides: Record<string, unknown> = {}): TrimMediaRequest {
  return {
    source: { kind: 'file', path: ctx.source },
    ffmpegPath: ctx.ffmpegPath,
    ffprobePath: ctx.ffprobePath,
    workspaceDirectory: ctx.dir,
    deadlineMs: 5000,
    signal: new AbortController().signal,
    container: 'mp4',
    startMs: 200,
    endMs: 800,
    precision: 'keyframe',
    durationToleranceMs: 50,
    ...overrides,
  } as TrimMediaRequest;
}

function encodeCalls(logPath: string): string[][] {
  return readInvocations(logPath).filter((args) => args.includes('-i') && !args.includes('-print_format'));
}

function encodeArgs(logPath: string): string[] {
  return encodeCalls(logPath)[0] ?? [];
}

function pair(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function readInvocations(logPath: string): string[][] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as string[]);
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

function probeDocument(options: {
  duration?: string;
  audio?: { codec?: string; sampleRate?: string } | null;
  width?: number;
  height?: number;
  fps?: string;
}): string {
  const duration = options.duration ?? '1.000000';
  const streams: Record<string, unknown>[] = [{
    codec_type: 'video',
    codec_name: 'h264',
    width: options.width ?? 160,
    height: options.height ?? 120,
    r_frame_rate: options.fps ?? '10/1',
    duration,
  }];
  if (options.audio) {
    streams.push({
      codec_type: 'audio',
      codec_name: options.audio.codec ?? 'aac',
      sample_rate: options.audio.sampleRate ?? '44100',
      channels: 1,
      duration,
    });
  }
  return JSON.stringify({
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration },
    streams,
  });
}

const FAKE_TOOL = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const log = process.env.MEDIA_FAKE_LOG;
if (log) appendFileSync(log, JSON.stringify(args) + '\\n');
if (args.includes('-encoders')) {
  const names = (process.env.MEDIA_FAKE_ENCODERS || 'libx264 aac libmp3lame png').split(/\\s+/).filter(Boolean);
  const codecs = { libx264: 'h264', aac: 'aac', libmp3lame: 'mp3', png: 'png' };
  for (const name of names) {
    const kind = name === 'aac' || name === 'libmp3lame' ? 'A' : 'V';
    const codec = codecs[name];
    const hint = codec ? ' (codec ' + codec + ')' : '';
    process.stdout.write(' ' + kind + '..... ' + name + ' encoder' + hint + '\\n');
  }
  process.exit(0);
}
if (args.includes('-print_format')) {
  const queuePath = process.env.MEDIA_FAKE_PROBES;
  let payload = process.env.MEDIA_FAKE_PROBE || '{}';
  if (queuePath) {
    const queue = JSON.parse(readFileSync(queuePath, 'utf8'));
    const next = queue.shift();
    writeFileSync(queuePath, JSON.stringify(queue));
    payload = JSON.stringify(next);
  }
  process.stdout.write(payload);
  process.exit(0);
}
const output = args[args.length - 1];
const mode = process.env.MEDIA_FAKE_MODE || 'ok';
if (mode === 'sleep') {
  if (process.env.MEDIA_FAKE_PID) writeFileSync(process.env.MEDIA_FAKE_PID, String(process.pid));
  setInterval(() => {}, 1000);
} else if (mode === 'delay-huge') {
  const delay = Number(process.env.MEDIA_FAKE_DELAY_MS || '0');
  const bytes = Number(process.env.MEDIA_FAKE_OUT_BYTES || '4000');
  setTimeout(() => {
    writeFileSync(output, Buffer.alloc(bytes, 9));
    process.exit(0);
  }, delay);
} else if (mode === 'shrink') {
  const countPath = process.env.MEDIA_FAKE_COUNT;
  let count = 0;
  if (countPath) {
    try { count = Number(readFileSync(countPath, 'utf8')); } catch (error) { count = 0; }
  }
  if (!Number.isFinite(count)) count = 0;
  count += 1;
  if (countPath) writeFileSync(countPath, String(count));
  const shrinkAt = Number(process.env.MEDIA_FAKE_SHRINK_AT || '2');
  const small = Number(process.env.MEDIA_FAKE_SMALL || '80');
  const large = Number(process.env.MEDIA_FAKE_LARGE || '5000');
  writeFileSync(output, Buffer.alloc(count >= shrinkAt ? small : large, 4));
  process.exit(0);
} else {
  const bytes = Number(process.env.MEDIA_FAKE_OUT_BYTES || '24');
  writeFileSync(output, Buffer.alloc(bytes, 3));
  process.exit(0);
}
`;
