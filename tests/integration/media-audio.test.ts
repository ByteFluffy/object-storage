import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { transcodeAudio } from '../../src/plugins/media/index.js';

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const FFPROBE = '/opt/homebrew/bin/ffprobe';

describe('media audio integration', () => {
  let dir = '';

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('transcodes the lavfi sine track to mp3', async () => {
    dir = await mkdtemp(join(tmpdir(), 'media-audio-'));
    const clip = join(dir, 'clip.mp4');
    await runTool(FFMPEG, [
      '-hide_banner', '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', '120000',
      '-c:a', 'aac', '-b:a', '64000',
      '-shortest', '-t', '1',
      clip,
    ]);
    const before = await stat(clip);
    const result = await transcodeAudio({
      source: { kind: 'file', path: clip },
      ffmpegPath: FFMPEG,
      ffprobePath: FFPROBE,
      workspaceDirectory: dir,
      deadlineMs: 20_000,
      signal: new AbortController().signal,
      container: 'mp3',
      audio: { encoder: 'libmp3lame', bitrate: 64_000 },
      durationToleranceMs: 200,
    });
    const inspected = await inspect(result.artifact.path);
    expect(inspected.format.format_name).toContain('mp3');
    expect(inspected.streams.some((stream) => stream.codec_type === 'video')).toBe(false);
    expect(inspected.streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'mp3')).toBe(true);
    expect(Math.abs(Math.round(Number(inspected.format.duration ?? '0') * 1000) - 1000)).toBeLessThanOrEqual(200);
    expect(result.artifact.mediaType).toBe('audio/mpeg');
    await result.artifact.release();
    expect((await stat(clip)).size).toBe(before.size);
  }, 30_000);
});

type Probe = { format: { format_name?: string; duration?: string }; streams: { codec_type?: string; codec_name?: string }[] };

async function inspect(path: string): Promise<Probe> {
  const stdout = await capture(FFPROBE, ['-hide_banner', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path]);
  return JSON.parse(stdout) as Probe;
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
