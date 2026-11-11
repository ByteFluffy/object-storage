import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { concatMedia, type ConcatMediaRequest } from '../../src/plugins/media/index.js';

describe('concatMedia', () => {
  it('rejects incompatible encodings when allowNormalize is not true', async () => {
    const ctx = await fakeContext();
    await writeFile(ctx.probes, JSON.stringify([
      probe('44100', 160, 120, '1.000000'),
      probe('22050', 80, 60, '1.000000'),
    ]));
    const restore = useFakeEnv({ MEDIA_FAKE_LOG: ctx.log, MEDIA_FAKE_PROBES: ctx.probes });
    try {
      await expect(concatMedia(concatRequest(ctx))).rejects.toMatchObject({ code: 'config_invalid' });
      await writeFile(ctx.probes, JSON.stringify([
        probe('44100', 160, 120, '1.000000'),
        probe('22050', 80, 60, '1.000000'),
      ]));
      await expect(concatMedia(concatRequest(ctx, { allowNormalize: false }))).rejects.toMatchObject({
        code: 'config_invalid',
      });
      expect(encodeCalls(ctx.log)).toHaveLength(0);
      expect(await readFile(ctx.first, 'utf8')).toBe('first');
      expect(await readFile(ctx.second, 'utf8')).toBe('second');
    } finally {
      restore();
    }
  });

  it('copies compatible inputs in caller order', async () => {
    const ctx = await fakeContext();
    await writeFile(ctx.probes, JSON.stringify([
      probe('44100', 160, 120, '1.000000'),
      probe('44100', 160, 120, '1.000000'),
      probe('44100', 160, 120, '2.000000'),
    ]));
    const restore = useFakeEnv({ MEDIA_FAKE_LOG: ctx.log, MEDIA_FAKE_PROBES: ctx.probes });
    try {
      const result = await concatMedia(concatRequest(ctx));
      const args = encodeCalls(ctx.log)[0] ?? [];
      expect(pair(args, '-f')).toBe('concat');
      expect(pair(args, '-c')).toBe('copy');
      const listPath = pair(args, '-i');
      expect(listPath).toBeDefined();
      const list = listPath ? await readFile(listPath, 'utf8') : '';
      expect(list.indexOf(ctx.first)).toBeGreaterThanOrEqual(0);
      expect(list.indexOf(ctx.second)).toBeGreaterThan(list.indexOf(ctx.first));
      expect(result.artifact.mediaType).toBe('video/mp4');
      await result.artifact.release();
    } finally {
      restore();
    }
  });

  it('re-encodes in caller order only when allowNormalize is true', async () => {
    const ctx = await fakeContext();
    await writeFile(ctx.probes, JSON.stringify([
      probe('44100', 160, 120, '1.000000'),
      probe('22050', 80, 60, '1.000000'),
    ]));
    const restore = useFakeEnv({ MEDIA_FAKE_LOG: ctx.log, MEDIA_FAKE_PROBES: ctx.probes });
    try {
      await expect(concatMedia(concatRequest(ctx, { allowNormalize: true }))).rejects.toMatchObject({
        code: 'config_missing',
      });
      await writeFile(ctx.probes, JSON.stringify([
        probe('44100', 160, 120, '1.000000'),
        probe('22050', 80, 60, '1.000000'),
        probe('44100', 160, 120, '2.000000'),
      ]));
      const result = await concatMedia(concatRequest(ctx, {
        allowNormalize: true,
        video: { encoder: 'libx264', bitrate: 80000, fps: 10, width: 160, height: 120 },
        audio: { encoder: 'aac', bitrate: 32000, sampleRate: 44100 },
      }));
      const args = encodeCalls(ctx.log)[0] ?? [];
      const inputs = inputPaths(args);
      expect(inputs[0]).toBe(ctx.first);
      expect(inputs[1]).toBe(ctx.second);
      expect(args.join('\n')).toContain('scale=160:120');
      expect(args.join('\n')).toContain('sample_rates=44100');
      expect(args).toContain('libx264');
      expect(pair(args, '-c')).not.toBe('copy');
      expect(args).not.toContain('-fs');
      await result.artifact.release();
    } finally {
      restore();
    }
  });
});

type Context = {
  dir: string;
  ffmpegPath: string;
  ffprobePath: string;
  first: string;
  second: string;
  log: string;
  probes: string;
};

async function fakeContext(): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'media-concat-'));
  const ffmpegPath = join(dir, 'ffmpeg');
  const ffprobePath = join(dir, 'ffprobe');
  await writeFile(ffmpegPath, FAKE_TOOL);
  await writeFile(ffprobePath, FAKE_TOOL);
  await chmod(ffmpegPath, 0o755);
  await chmod(ffprobePath, 0o755);
  const first = join(dir, 'a.mp4');
  const second = join(dir, 'b.mp4');
  await writeFile(first, 'first');
  await writeFile(second, 'second');
  return { dir, ffmpegPath, ffprobePath, first, second, log: join(dir, 'calls.log'), probes: join(dir, 'probes.json') };
}

function concatRequest(ctx: Context, overrides: Record<string, unknown> = {}): ConcatMediaRequest {
  return {
    sources: [{ kind: 'file', path: ctx.first }, { kind: 'file', path: ctx.second }],
    ffmpegPath: ctx.ffmpegPath,
    ffprobePath: ctx.ffprobePath,
    workspaceDirectory: ctx.dir,
    deadlineMs: 5000,
    signal: new AbortController().signal,
    container: 'mp4',
    durationToleranceMs: 50,
    ...overrides,
  } as ConcatMediaRequest;
}

function probe(sampleRate: string, width: number, height: number, duration: string): unknown {
  return {
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration },
    streams: [
      { codec_type: 'video', codec_name: 'h264', width, height, r_frame_rate: '10/1', duration },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: sampleRate, channels: 1, duration },
    ],
  };
}

function encodeCalls(logPath: string): string[][] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[])
    .filter((args) => args.includes('-i') && !args.includes('-print_format'));
}

function pair(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function inputPaths(args: readonly string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-i') {
      const next = args[index + 1];
      if (next !== undefined) paths.push(next);
    }
  }
  return paths;
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

const FAKE_TOOL = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (process.env.MEDIA_FAKE_LOG) appendFileSync(process.env.MEDIA_FAKE_LOG, JSON.stringify(args) + '\\n');
if (args.includes('-encoders')) {
  process.stdout.write(' V..... libx264 encoder (codec h264)\\n');
  process.stdout.write(' A..... aac encoder (codec aac)\\n');
  process.exit(0);
}
if (args.includes('-print_format')) {
  const queue = JSON.parse(readFileSync(process.env.MEDIA_FAKE_PROBES, 'utf8'));
  const next = queue.shift();
  writeFileSync(process.env.MEDIA_FAKE_PROBES, JSON.stringify(queue));
  process.stdout.write(JSON.stringify(next));
  process.exit(0);
}
writeFileSync(args[args.length - 1], Buffer.alloc(20, 6));
process.exit(0);
`;
