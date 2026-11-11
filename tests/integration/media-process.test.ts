import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeMedia, transcodeVideo } from '../../src/plugins/media/index.js';

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const FFPROBE = '/opt/homebrew/bin/ffprobe';

describe('media process integration', () => {
  let dir = '';
  let clip = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'media-process-'));
    clip = join(dir, 'clip.mp4');
    await makeClip(clip);
  }, 30_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('probes a short lavfi clip without removing the input', async () => {
    const before = await stat(clip);
    const probed = await probeMedia({
      source: { kind: 'file', path: clip },
      ffmpegPath: FFMPEG,
      ffprobePath: FFPROBE,
      workspaceDirectory: dir,
      deadlineMs: 20_000,
      signal: new AbortController().signal,
    });
    expect(probed.formatName).toContain('mp4');
    expect(probed.video).toMatchObject({ codec: 'h264', width: 160, height: 120 });
    expect(probed.video?.fps).toBeCloseTo(10, 0);
    expect(probed.audio).toMatchObject({ codec: 'aac', sampleRate: 44100, channels: 1 });
    expect(Math.abs(probed.durationMs - 1000)).toBeLessThanOrEqual(50);
    expect(probed.byteLength).toBe(before.size);
    expect(probed.inputChecksum).toEqual({
      algorithm: 'sha256',
      value: createHash('sha256').update(await readFile(clip)).digest('hex'),
    });
    expect((await stat(clip)).size).toBe(before.size);
  }, 30_000);

  it('kills a real ffmpeg when the deadline is exceeded', async () => {
    const started = Date.now();
    await expect(transcodeVideo({
      source: { kind: 'file', path: clip },
      ffmpegPath: FFMPEG,
      ffprobePath: FFPROBE,
      workspaceDirectory: dir,
      deadlineMs: 10,
      signal: new AbortController().signal,
      container: 'mp4',
      video: { encoder: 'libx264', bitrate: 80_000 },
      audio: { encoder: 'aac', bitrate: 32_000 },
      durationToleranceMs: 200,
    })).rejects.toMatchObject({ code: 'cancelled' });
    expect(Date.now() - started).toBeLessThan(3000);
    expect((await stat(clip)).isFile()).toBe(true);
  }, 30_000);

  it('does not pull a stream when the tool path is missing', async () => {
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    }, { highWaterMark: 0 });
    await expect(transcodeVideo({
      source: { kind: 'stream', stream },
      ffmpegPath: join(dir, 'missing-ffmpeg'),
      ffprobePath: FFPROBE,
      workspaceDirectory: dir,
      deadlineMs: 5000,
      signal: new AbortController().signal,
      container: 'mp4',
      video: { encoder: 'libx264', bitrate: 80_000 },
      audio: { encoder: 'aac', bitrate: 32_000 },
      durationToleranceMs: 200,
    })).rejects.toMatchObject({ code: 'capability_unsupported' });
    expect(pulled).toBe(false);
  });

  it('keeps the artifact readable until release', async () => {
    const before = await stat(clip);
    const result = await transcodeVideo({
      source: { kind: 'file', path: clip },
      ffmpegPath: FFMPEG,
      ffprobePath: FFPROBE,
      workspaceDirectory: dir,
      deadlineMs: 20_000,
      signal: new AbortController().signal,
      container: 'mp4',
      video: { encoder: 'libx264', bitrate: 80_000 },
      audio: { encoder: 'aac', bitrate: 32_000 },
      durationToleranceMs: 200,
    });
    const bytes = await result.artifact.read();
    expect(bytes.byteLength).toBe(result.artifact.byteLength);
    expect(result.artifact.checksum).toEqual(result.outputChecksum);
    const inspected = await inspect(result.artifact.path);
    expect(inspected.format.format_name).toContain('mp4');
    expect(inspected.streams.some((stream) => stream.codec_type === 'video' && stream.codec_name === 'h264')).toBe(true);
    expect(inspected.streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac')).toBe(true);
    await result.artifact.release();
    await expect(result.artifact.read()).rejects.toMatchObject({ code: 'conflict' });
    expect((await stat(clip)).size).toBe(before.size);
  }, 30_000);
});

async function makeClip(path: string): Promise<void> {
  await runTool(FFMPEG, [
    '-hide_banner', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', '120000',
    '-c:a', 'aac', '-b:a', '64000',
    '-shortest', '-t', '1',
    path,
  ]);
}

async function inspect(path: string): Promise<{
  format: { format_name: string; duration?: string };
  streams: { codec_type?: string; codec_name?: string; width?: number; height?: number }[];
}> {
  const stdout = await capture(FFPROBE, ['-hide_banner', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path]);
  return JSON.parse(stdout) as {
    format: { format_name: string; duration?: string };
    streams: { codec_type?: string; codec_name?: string; width?: number; height?: number }[];
  };
}

function runTool(command: string, args: readonly string[]): Promise<void> {
  return capture(command, args).then(() => undefined);
}

function capture(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
      else reject(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString('utf8').slice(-500)}`));
    });
  });
}
