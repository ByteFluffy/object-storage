import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { transcodeVideo, type TranscodeVideoRequest } from '../../src/plugins/media/index.js';

const FAKE_KEYS = [
  'MEDIA_FAKE_LOG',
  'MEDIA_FAKE_ENCODERS',
  'MEDIA_FAKE_PROBES',
  'MEDIA_FAKE_PROBE',
  'MEDIA_FAKE_MODE',
  'MEDIA_FAKE_PID',
  'MEDIA_FAKE_DELAY_MS',
  'MEDIA_FAKE_OUT_BYTES',
  'MEDIA_FAKE_COUNT',
  'MEDIA_FAKE_SHRINK_AT',
  'MEDIA_FAKE_SMALL',
  'MEDIA_FAKE_LARGE',
] as const;

const FAKE_TOOL = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const log = process.env.MEDIA_FAKE_LOG;
if (log) appendFileSync(log, JSON.stringify(args) + '\\n');
if (args.includes('-encoders')) {
  const names = (process.env.MEDIA_FAKE_ENCODERS || 'libx264 aac libmp3lame png').split(/\\s+/).filter(Boolean);
  const codecs = { libx264: 'h264', aac: 'aac', libmp3lame: 'mp3', png: 'png', libvpx: 'vp8', 'libvpx-vp9': 'vp9', mpeg4: 'mpeg4' };
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

let activePid: number | undefined;

afterEach(() => {
  if (activePid === undefined) return;
  try {
    process.kill(activePid, 'SIGKILL');
  } catch {
    // The timed-out child is already gone.
  }
  activePid = undefined;
});

describe('media process guard', () => {
  it('rejects a missing tool before a stream is pulled', async () => {
    const { source, pulled } = sealedStream();
    const dir = await mkdtemp(join(tmpdir(), 'media-missing-'));
    await expect(transcodeVideo(videoRequest(dir, {
      ffmpegPath: join(dir, 'missing-ffmpeg'),
      ffprobePath: join(dir, 'missing-ffprobe'),
      source,
    }))).rejects.toMatchObject({ name: 'StorageError', code: 'capability_unsupported' });
    expect(pulled()).toBe(false);
  });

  it('rejects a missing encoder before a stream is pulled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'media-encoder-'));
    const tools = await installFakeTools(dir);
    const { source, pulled } = sealedStream();
    const restore = useFakeEnv({ MEDIA_FAKE_ENCODERS: 'aac png', MEDIA_FAKE_LOG: join(dir, 'calls.log') });
    try {
      await expect(transcodeVideo(videoRequest(dir, { ...tools, source }))).rejects.toMatchObject({
        code: 'capability_unsupported',
      });
      expect(pulled()).toBe(false);
      expect(readInvocations(join(dir, 'calls.log')).some((args) => args.includes('-i'))).toBe(false);
    } finally {
      restore();
    }
  });

  it('rejects incomplete configuration before a stream is pulled', async () => {
    const { source, pulled } = sealedStream();
    const dir = await mkdtemp(join(tmpdir(), 'media-config-'));
    await expect(transcodeVideo(videoRequest(dir, {
      source,
      deadlineMs: undefined,
    }))).rejects.toMatchObject({ code: 'config_missing' });
    await expect(transcodeVideo(videoRequest(dir, {
      source,
      signal: undefined,
    }))).rejects.toMatchObject({ code: 'config_missing' });
    expect(pulled()).toBe(false);
  });

  it('does not pull a stream that is already over the byte budget', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'media-budget-'));
    const tools = await installFakeTools(dir);
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const restore = useFakeEnv({ MEDIA_FAKE_PROBE: probeDocument({ audio: {} }) });
    try {
      await expect(transcodeVideo(videoRequest(dir, {
        ...tools,
        maxInputBytes: 4,
        source: { kind: 'stream', stream, declaredByteLength: 32 },
      }))).rejects.toMatchObject({ code: 'input_too_large' });
      expect(pulled).toBe(false);
    } finally {
      restore();
    }
  });

  it('cancels before starting a tool or reading the stream', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'media-abort-'));
    const { source, pulled } = sealedStream();
    const controller = new AbortController();
    controller.abort();
    const log = join(dir, 'calls.log');
    const restore = useFakeEnv({ MEDIA_FAKE_LOG: log, MEDIA_FAKE_MODE: 'sleep' });
    try {
      await expect(transcodeVideo(videoRequest(dir, {
        ffmpegPath: join(dir, 'missing-ffmpeg'),
        ffprobePath: join(dir, 'missing-ffprobe'),
        source,
        signal: controller.signal,
      }))).rejects.toMatchObject({ code: 'cancelled', message: 'operation cancelled' });
      expect(pulled()).toBe(false);
      expect(existsSync(log)).toBe(false);
    } finally {
      restore();
    }
  });

  it('kills a running ffmpeg when the deadline is exceeded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'media-deadline-'));
    const tools = await installFakeTools(dir);
    const source = join(dir, 'clip.bin');
    await writeFile(source, 'input-bytes');
    const pidFile = join(dir, 'pid');
    const restore = useFakeEnv({
      MEDIA_FAKE_LOG: join(dir, 'calls.log'),
      MEDIA_FAKE_MODE: 'sleep',
      MEDIA_FAKE_PID: pidFile,
      MEDIA_FAKE_PROBE: probeDocument({ audio: {} }),
    });
    const started = Date.now();
    const pending = transcodeVideo(videoRequest(dir, { ...tools, source: { kind: 'file', path: source }, deadlineMs: 400 }));
    try {
      activePid = await waitForPid(pidFile);
      await expect(pending).rejects.toMatchObject({ code: 'cancelled', message: 'deadline exceeded' });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(alive(activePid)).toBe(false);
      expect(await readFile(source, 'utf8')).toBe('input-bytes');
    } finally {
      restore();
    }
  });

  it('kills a running ffmpeg when the caller aborts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'media-cancel-'));
    const tools = await installFakeTools(dir);
    const source = join(dir, 'clip.bin');
    await writeFile(source, 'input-bytes');
    const pidFile = join(dir, 'pid');
    const controller = new AbortController();
    const restore = useFakeEnv({
      MEDIA_FAKE_MODE: 'sleep',
      MEDIA_FAKE_PID: pidFile,
      MEDIA_FAKE_PROBE: probeDocument({ audio: {} }),
    });
    const pending = transcodeVideo(videoRequest(dir, {
      ...tools,
      source: { kind: 'file', path: source },
      signal: controller.signal,
      deadlineMs: 5000,
    }));
    try {
      activePid = await waitForPid(pidFile);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'cancelled', message: 'operation cancelled' });
      expect(alive(activePid)).toBe(false);
    } finally {
      restore();
    }
  });

  it('passes a shell metacharacter path as one argv element', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'media-shell-'));
    const tools = await installFakeTools(dir);
    const marker = join(process.cwd(), 'media-shell-marker.mp4');
    const source = join(dir, 'clip;touch media-shell-marker.mp4');
    await writeFile(source, 'input-bytes');
    const log = join(dir, 'calls.log');
    const restore = useFakeEnv({
      MEDIA_FAKE_LOG: log,
      MEDIA_FAKE_PROBE: probeDocument({ audio: {} }),
      MEDIA_FAKE_OUT_BYTES: '24',
    });
    try {
      const result = await transcodeVideo(videoRequest(dir, { ...tools, source: { kind: 'file', path: source } }));
      const encoded = readInvocations(log).find((args) => args.includes('-c:v'));
      expect(encoded).toBeDefined();
      expect(encoded).toContain(source);
      expect(existsSync(marker)).toBe(false);
      expect(await result.artifact.read()).toHaveLength(24);
      await result.artifact.release();
      await expect(result.artifact.read()).rejects.toMatchObject({ code: 'conflict' });
      expect(await readFile(source, 'utf8')).toBe('input-bytes');
    } finally {
      restore();
      await rm(marker, { force: true });
    }
  });

  it('does not enable a shell or a filesize truncation flag', () => {
    const directory = fileURLToPath(new URL('../../src/plugins/media/', import.meta.url));
    const names = readdirSync(directory).filter((name) => name.endsWith('.ts'));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const text = readFileSync(join(directory, name), 'utf8');
      expect(text).not.toMatch(/shell\s*:\s*true/);
      expect(text).not.toMatch(/['"]-fs['"]/);
      expect(text).not.toMatch(/\bexecFile\(|\bexecSync\(|\bspawnSync\(/);
    }
  });
});

function videoRequest(dir: string, overrides: Record<string, unknown>): TranscodeVideoRequest {
  return {
    source: { kind: 'bytes', data: new Uint8Array([1]) },
    ffmpegPath: join(dir, 'ffmpeg'),
    ffprobePath: join(dir, 'ffprobe'),
    workspaceDirectory: dir,
    deadlineMs: 5000,
    signal: new AbortController().signal,
    container: 'mp4',
    video: { encoder: 'libx264', bitrate: 100000 },
    audio: { encoder: 'aac', bitrate: 48000 },
    durationToleranceMs: 50,
    ...overrides,
  } as TranscodeVideoRequest;
}

function sealedStream(): { source: { kind: 'stream'; stream: ReadableStream<Uint8Array> }; pulled: () => boolean } {
  let didPull = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      didPull = true;
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  }, { highWaterMark: 0 });
  return { source: { kind: 'stream', stream }, pulled: () => didPull };
}

export async function installFakeTools(dir: string): Promise<{ ffmpegPath: string; ffprobePath: string }> {
  const ffmpegPath = join(dir, 'ffmpeg');
  const ffprobePath = join(dir, 'ffprobe');
  await writeFile(ffmpegPath, FAKE_TOOL);
  await writeFile(ffprobePath, FAKE_TOOL);
  await chmod(ffmpegPath, 0o755);
  await chmod(ffprobePath, 0o755);
  return { ffmpegPath, ffprobePath };
}

export function useFakeEnv(values: Record<string, string>): () => void {
  const previous = new Map(FAKE_KEYS.map((key) => [key, process.env[key]]));
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  return () => {
    for (const key of FAKE_KEYS) delete process.env[key];
    for (const [key, value] of previous) {
      if (value !== undefined) process.env[key] = value;
    }
  };
}

export function probeDocument(options: {
  format?: string;
  duration?: string;
  video?: { codec?: string; width?: number; height?: number; fps?: string } | null;
  audio?: { codec?: string; sampleRate?: string; channels?: number } | null;
}): string {
  const duration = options.duration ?? '1.000000';
  const streams: Record<string, unknown>[] = [];
  if (options.video !== null) {
    const video = options.video ?? {};
    streams.push({
      codec_type: 'video',
      codec_name: video.codec ?? 'h264',
      width: video.width ?? 160,
      height: video.height ?? 120,
      r_frame_rate: video.fps ?? '10/1',
      duration,
    });
  }
  if (options.audio) {
    streams.push({
      codec_type: 'audio',
      codec_name: options.audio.codec ?? 'aac',
      sample_rate: options.audio.sampleRate ?? '44100',
      channels: options.audio.channels ?? 1,
      duration,
    });
  }
  return JSON.stringify({
    format: { format_name: options.format ?? 'mov,mp4,m4a,3gp,3g2,mj2', duration },
    streams,
  });
}

export function readInvocations(logPath: string): string[][] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPid(file: string): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(file)) {
      const pid = Number(readFileSync(file, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('fake ffmpeg did not record a pid');
}
