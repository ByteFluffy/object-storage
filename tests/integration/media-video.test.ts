import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compressVideo, transcodeVideo } from '../../src/plugins/media/index.js';

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const FFPROBE = '/opt/homebrew/bin/ffprobe';

describe('media video integration', () => {
  let dir = '';
  let clip = '';
  let silent = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'media-video-'));
    clip = join(dir, 'clip.mp4');
    silent = join(dir, 'silent.mp4');
    await makeClip(clip, {});
    await makeClip(silent, { silent: true });
  }, 30_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('keeps audio and the source frame size when the caller does not set one', async () => {
    const before = await stat(clip);
    const result = await transcodeVideo(request(clip, {}));
    const inspected = await inspect(result.artifact.path);
    expect(inspected.format.format_name).toContain('mp4');
    expect(videoOf(inspected)).toMatchObject({ codec_name: 'h264', width: 160, height: 120 });
    expect(inspected.streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac')).toBe(true);
    expect(durationMs(inspected)).toBeGreaterThan(800);
    expect(durationMs(inspected)).toBeLessThan(1200);
    await result.artifact.release();
    expect((await stat(clip)).size).toBe(before.size);
  }, 30_000);

  it('drops audio only when requested and honors a caller frame size', async () => {
    const before = await stat(clip);
    const dropped = await transcodeVideo(request(clip, { dropAudio: true, audio: undefined }));
    const droppedProbe = await inspect(dropped.artifact.path);
    expect(droppedProbe.streams.some((stream) => stream.codec_type === 'audio')).toBe(false);
    expect(videoOf(droppedProbe)?.codec_name).toBe('h264');
    await dropped.artifact.release();

    const scaled = await transcodeVideo(request(clip, {
      video: { encoder: 'libx264', bitrate: 80_000, fps: 10, width: 80, height: 60 },
    }));
    const scaledProbe = await inspect(scaled.artifact.path);
    expect(videoOf(scaledProbe)).toMatchObject({ codec_name: 'h264', width: 80, height: 60 });
    expect(scaledProbe.streams.some((stream) => stream.codec_type === 'audio')).toBe(true);
    await scaled.artifact.release();
    expect((await stat(clip)).size).toBe(before.size);
  }, 30_000);

  it('rejects an audio encode when the input has no audio track', async () => {
    const before = await stat(silent);
    await expect(transcodeVideo(request(silent, {}))).rejects.toMatchObject({ code: 'config_invalid' });
    expect((await stat(silent)).size).toBe(before.size);
  }, 30_000);

  it('reaches a caller byte budget from the original input and keeps audio', async () => {
    const before = await stat(clip);
    const result = await compressVideo({
      source: { kind: 'file', path: clip },
      ffmpegPath: FFMPEG,
      ffprobePath: FFPROBE,
      workspaceDirectory: dir,
      deadlineMs: 20_000,
      signal: new AbortController().signal,
      container: 'mp4',
      videoEncoder: 'libx264',
      audio: { encoder: 'aac', bitrate: 16_000 },
      maxBytes: 9_000,
      maxAttempts: 3,
      durationToleranceMs: 200,
    });
    expect(result.artifact.byteLength).toBeLessThanOrEqual(9_000);
    expect(result.artifact.byteLength).toBeLessThan(before.size);
    const inspected = await inspect(result.artifact.path);
    expect(inspected.format.format_name).toContain('mp4');
    expect(videoOf(inspected)?.codec_name).toBe('h264');
    expect(inspected.streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac')).toBe(true);
    expect(Math.abs(durationMs(inspected) - 1000)).toBeLessThanOrEqual(200);
    await result.artifact.release();
    expect((await stat(clip)).size).toBe(before.size);
  }, 30_000);

  it('reports constraint_unsatisfied when the target cannot be reached', async () => {
    const before = await stat(clip);
    await expect(compressVideo({
      source: { kind: 'file', path: clip },
      ffmpegPath: FFMPEG,
      ffprobePath: FFPROBE,
      workspaceDirectory: dir,
      deadlineMs: 20_000,
      signal: new AbortController().signal,
      container: 'mp4',
      videoEncoder: 'libx264',
      audio: { encoder: 'aac', bitrate: 64_000 },
      maxBytes: 400,
      maxAttempts: 2,
      durationToleranceMs: 200,
    })).rejects.toMatchObject({ code: 'constraint_unsatisfied' });
    expect((await stat(clip)).size).toBe(before.size);
  }, 30_000);
});

function request(path: string, overrides: Record<string, unknown>) {
  return {
    source: { kind: 'file' as const, path },
    ffmpegPath: FFMPEG,
    ffprobePath: FFPROBE,
    workspaceDirectory: dirOf(path),
    deadlineMs: 20_000,
    signal: new AbortController().signal,
    container: 'mp4' as const,
    video: { encoder: 'libx264', bitrate: 80_000 },
    audio: { encoder: 'aac', bitrate: 32_000 },
    durationToleranceMs: 200,
    ...overrides,
  };
}

function dirOf(path: string): string {
  return join(path, '..');
}

async function makeClip(path: string, options: { silent?: boolean }): Promise<void> {
  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1',
  ];
  if (!options.silent) {
    args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1');
  }
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', '120000');
  if (options.silent) args.push('-an');
  else args.push('-c:a', 'aac', '-b:a', '64000', '-shortest');
  args.push('-t', '1', path);
  await runTool(FFMPEG, args);
}

type Probe = {
  format: { format_name?: string; duration?: string };
  streams: { codec_type?: string; codec_name?: string; width?: number; height?: number }[];
};

async function inspect(path: string): Promise<Probe> {
  const stdout = await capture(FFPROBE, ['-hide_banner', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path]);
  return JSON.parse(stdout) as Probe;
}

function videoOf(probe: Probe): Probe['streams'][number] | undefined {
  return probe.streams.find((stream) => stream.codec_type === 'video');
}

function durationMs(probe: Probe): number {
  return Math.round(Number(probe.format.duration ?? '0') * 1000);
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
