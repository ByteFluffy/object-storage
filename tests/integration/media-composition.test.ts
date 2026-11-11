import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { concatMedia, trimMedia } from '../../src/plugins/media/index.js';

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const FFPROBE = '/opt/homebrew/bin/ffprobe';

describe('media composition integration', () => {
  let dir = '';
  let first = '';
  let second = '';
  let different = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'media-composition-'));
    first = join(dir, 'a.mp4');
    second = join(dir, 'b.mp4');
    different = join(dir, 'c.mp4');
    await makeClip(first, { negate: false, sampleRate: 44100 });
    await makeClip(second, { negate: true, sampleRate: 44100 });
    await makeClip(different, { negate: true, sampleRate: 22050 });
  }, 30_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('trims exactly and does not call a keyframe copy frame accurate', async () => {
    const before = await stat(first);

    const exact = await trimMedia({
      source: { kind: 'file', path: first },
      ffmpegPath: FFMPEG,
      ffprobePath: FFPROBE,
      workspaceDirectory: dir,
      deadlineMs: 20_000,
      signal: new AbortController().signal,
      container: 'mp4',
      startMs: 200,
      endMs: 800,
      precision: 'exact',
      video: { encoder: 'libx264', bitrate: 80_000 },
      audio: { encoder: 'aac', bitrate: 32_000 },
      durationToleranceMs: 80,
    });
    expect(exact.precision).toBe('exact');
    expect(exact.frameAccurate).toBe(true);
    const exactProbe = await inspect(exact.artifact.path);
    expect(exactProbe.format.format_name).toContain('mp4');
    expect(videoOf(exactProbe)?.codec_name).toBe('h264');
    expect(exactProbe.streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac')).toBe(true);
    expect(Math.abs(durationMs(exactProbe) - 600)).toBeLessThanOrEqual(80);
    await exact.artifact.release();

    const keyframe = await trimMedia({
      source: { kind: 'file', path: first },
      ffmpegPath: FFMPEG,
      ffprobePath: FFPROBE,
      workspaceDirectory: dir,
      deadlineMs: 20_000,
      signal: new AbortController().signal,
      container: 'mp4',
      startMs: 200,
      endMs: 800,
      precision: 'keyframe',
      durationToleranceMs: 500,
    });
    expect(keyframe.precision).toBe('keyframe');
    expect(keyframe.frameAccurate).toBe(false);
    const keyProbe = await inspect(keyframe.artifact.path);
    expect(keyProbe.format.format_name).toContain('mp4');
    expect(videoOf(keyProbe)?.codec_name).toBe('h264');
    expect(keyProbe.streams.some((stream) => stream.codec_type === 'audio')).toBe(true);
    expect(Math.abs(durationMs(keyProbe) - 600)).toBeLessThanOrEqual(500);
    await keyframe.artifact.release();
    expect((await stat(first)).size).toBe(before.size);
  }, 30_000);

  it('copies compatible clips in order and checks the total duration', async () => {
    const beforeA = await stat(first);
    const beforeB = await stat(second);
    const result = await concatMedia({
      sources: [{ kind: 'file', path: first }, { kind: 'file', path: second }],
      ffmpegPath: FFMPEG,
      ffprobePath: FFPROBE,
      workspaceDirectory: dir,
      deadlineMs: 20_000,
      signal: new AbortController().signal,
      container: 'mp4',
      durationToleranceMs: 150,
    });
    const inspected = await inspect(result.artifact.path);
    expect(inspected.format.format_name).toContain('mp4');
    expect(videoOf(inspected)?.codec_name).toBe('h264');
    expect(inspected.streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac')).toBe(true);
    expect(Math.abs(durationMs(inspected) - 2000)).toBeLessThanOrEqual(150);
    const early = join(dir, 'early.png');
    const late = join(dir, 'late.png');
    const fromA = join(dir, 'from-a.png');
    const fromB = join(dir, 'from-b.png');
    await frameAt(result.artifact.path, 1, early);
    await frameAt(result.artifact.path, 11, late);
    await frameAt(first, 1, fromA);
    await frameAt(second, 1, fromB);
    expect(await sha(early)).toBe(await sha(fromA));
    expect(await sha(late)).toBe(await sha(fromB));
    expect(await sha(fromA)).not.toBe(await sha(fromB));
    await result.artifact.release();
    expect((await stat(first)).size).toBe(beforeA.size);
    expect((await stat(second)).size).toBe(beforeB.size);
  }, 30_000);

  it('rejects incompatible clips unless normalization is allowed', async () => {
    const before = await stat(different);
    await expect(concatMedia({
      sources: [{ kind: 'file', path: first }, { kind: 'file', path: different }],
      ffmpegPath: FFMPEG,
      ffprobePath: FFPROBE,
      workspaceDirectory: dir,
      deadlineMs: 20_000,
      signal: new AbortController().signal,
      container: 'mp4',
      durationToleranceMs: 150,
    })).rejects.toMatchObject({ code: 'config_invalid' });
    expect((await stat(different)).size).toBe(before.size);

    const normalized = await concatMedia({
      sources: [{ kind: 'file', path: first }, { kind: 'file', path: different }],
      ffmpegPath: FFMPEG,
      ffprobePath: FFPROBE,
      workspaceDirectory: dir,
      deadlineMs: 20_000,
      signal: new AbortController().signal,
      container: 'mp4',
      allowNormalize: true,
      video: { encoder: 'libx264', bitrate: 80_000, fps: 10, width: 160, height: 120 },
      audio: { encoder: 'aac', bitrate: 32_000, sampleRate: 44100 },
      durationToleranceMs: 200,
    });
    const inspected = await inspect(normalized.artifact.path);
    expect(inspected.format.format_name).toContain('mp4');
    expect(videoOf(inspected)).toMatchObject({ codec_name: 'h264', width: 160, height: 120 });
    expect(inspected.streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac')).toBe(true);
    expect(Math.abs(durationMs(inspected) - 2000)).toBeLessThanOrEqual(200);
    await normalized.artifact.release();
    expect((await stat(first)).size).toBeGreaterThan(0);
    expect((await stat(different)).size).toBe(before.size);
  }, 30_000);
});

async function makeClip(path: string, options: { negate: boolean; sampleRate: number }): Promise<void> {
  const video = options.negate
    ? 'testsrc=size=160x120:rate=10:duration=1,negate'
    : 'testsrc=size=160x120:rate=10:duration=1';
  await runTool(FFMPEG, [
    '-hide_banner', '-nostdin', '-y',
    '-f', 'lavfi', '-i', video,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${options.sampleRate}:duration=1`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', '120000',
    '-c:a', 'aac', '-b:a', '64000',
    '-shortest', '-t', '1',
    path,
  ]);
}

async function frameAt(input: string, frame: number, output: string): Promise<void> {
  await runTool(FFMPEG, [
    '-hide_banner', '-nostdin', '-y',
    '-i', input,
    '-vf', `select=eq(n\\,${frame})`,
    '-frames:v', '1',
    '-update', '1',
    output,
  ]);
}

async function sha(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
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
