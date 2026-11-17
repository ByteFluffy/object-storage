import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareMediaProbe, probeMedia, type ProbeMediaRequest } from '../../src/plugins/media/index.js';

const io = vi.hoisted(() => ({ mkdtemp: vi.fn() }));
vi.mock('node:fs/promises', async original => ({
  ...await original<typeof import('node:fs/promises')>(), mkdtemp: io.mkdtemp,
}));

let directory = '';
let tool = '';
const bytes = new Uint8Array([1, 2, 3]);
const document = () => ({ format: { format_name: 'mov,mp4', duration: '1.234567' }, streams: [{
  codec_type: 'video', codec_name: 'h264', width: 160, height: 90, r_frame_rate: '24/1',
}] });
const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json'), 'utf8'));
fs.writeFileSync(path.join(__dirname, 'args.json'), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(path.join(__dirname, 'pid'), String(process.pid));
if (state.mode === 'stdout' || state.mode === 'stderr') {
  process[state.mode].write(Buffer.alloc(1000001, 120));
  setTimeout(() => {}, 5000);
} else if (state.mode === 'sleep') {
  setTimeout(() => {}, 5000);
} else {
  process.stdout.write(state.mode === 'corrupt' ? 'invalid probe json' : JSON.stringify(state.probe));
}
`;

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  io.mkdtemp.mockReset().mockImplementation(actual.mkdtemp);
  directory = await mkdtemp(join(tmpdir(), 'prepare-probe-test-'));
  tool = join(directory, 'ffprobe-test.cjs');
  await writeFile(tool, script);
  await chmod(tool, 0o755);
  await writeFile(join(directory, 'state.json'), JSON.stringify({ probe: document() }));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function request(source: ProbeMediaRequest['source'], extra: Partial<ProbeMediaRequest> & {
  probeTimeoutMs?: number; inputArgs?: readonly string[]; maxOutputBytes?: number;
  durationSource?: 'first-valid' | 'container-or-first-video';
} = {}) {
  return { source, ffmpegPath: tool, ffprobePath: tool, workspaceDirectory: directory,
    deadlineMs: 2_000, signal: new AbortController().signal, ...extra };
}
async function workspaces() {
  return (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
}
async function mode(value: string) {
  await writeFile(join(directory, 'state.json'), JSON.stringify({ mode: value, probe: document() }));
}

// These exercise the existing entry point so API absence cannot mask regressions.
describe('probeMedia compatibility', () => {
  it('keeps sub-millisecond duration precision and releases its owned snapshot', async () => {
    const result = await probeMedia(request({ kind: 'bytes', data: bytes }));
    expect(result.durationMs).toBeCloseTo(1234.567, 6);
    expect(result).not.toHaveProperty('filePath');
    expect(result).not.toHaveProperty('body');
    expect(result).not.toHaveProperty('release');
    expect(await workspaces()).toEqual([]);
  });

  it.each([
    { side_data_list: [{ rotation: 90 }], tags: { rotate: '180' }, expected: 90 },
    { side_data_list: [{ rotation: 'invalid' }], tags: { rotate: '-90' }, expected: -90 },
  ])('reports display rotation while preserving coded dimensions: %j', async ({ expected, ...rotation }) => {
    const probe = document();
    Object.assign(probe.streams[0]!, rotation);
    await writeFile(join(directory, 'state.json'), JSON.stringify({ probe }));
    const result = await probeMedia(request({ kind: 'bytes', data: bytes }));
    expect(result.video).toMatchObject({ width: 160, height: 90, rotation: expected });
  });

  it('passes explicit ffprobe input options before the media path', async () => {
    await probeMedia(request({ kind: 'bytes', data: bytes }, {
      inputArgs: ['-protocol_whitelist', 'file', '-enable_drefs', '0'],
    }));
    const args = JSON.parse(await readFile(join(directory, 'args.json'), 'utf8')) as string[];
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file');
    expect(args[args.indexOf('-enable_drefs') + 1]).toBe('0');
  });

  it('probes without implicit protocol restrictions or an output byte limit', async () => {
    await writeFile(join(directory, 'state.json'), JSON.stringify({ probe: { ...document(), padding: 'x'.repeat(1_000_001) } }));
    const result = await probeMedia(request({ kind: 'bytes', data: bytes }));
    expect(result.video).toMatchObject({ width: 160, height: 90 });
    const args = JSON.parse(await readFile(join(directory, 'args.json'), 'utf8')) as string[];
    expect(args).not.toContain('-protocol_whitelist');
    expect(args).not.toContain('-enable_drefs');
  });
});

describe.each(['probeMedia', 'prepareMediaProbe'] as const)('%s duration source policy', entry => {
  const audio = { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, duration: '2' };
  const video = { ...document().streams[0]!, duration: '1.5' };

  it.each([
    { name: 'audio-first source without container duration', container: undefined, streams: [audio, video], expected: 1500 },
    { name: 'container priority over stream duration', container: '1.25', streams: [audio, video], expected: 1250 },
    { name: 'invalid present container duration', container: 'N/A', streams: [audio, video], expected: 0 },
    { name: 'zero present container duration', container: '0', streams: [audio, video], expected: 0 },
    { name: 'negative present container duration', container: '-1', streams: [audio, video], expected: 0 },
    { name: 'only the first video duration', container: undefined, streams: [audio, video, { ...video, duration: '9' }], expected: 1500 },
    { name: 'invalid first video without borrowing a later video', container: undefined, streams: [audio, { ...video, duration: 'N/A' }, { ...video, duration: '9' }], expected: 0 },
    { name: 'null container duration falls back to the first video', container: null, streams: [audio, video], expected: 1500 },
  ])('uses container-or-first-video for $name', async ({ container, streams, expected }) => {
    await writeFile(join(directory, 'state.json'), JSON.stringify({ probe: {
      format: { format_name: 'matroska', ...(container === undefined ? {} : { duration: container }) }, streams,
    } }));
    const input = request({ kind: 'bytes', data: bytes }, { durationSource: 'container-or-first-video' });
    const result = entry === 'probeMedia' ? await probeMedia(input) : await prepareMediaProbe(input);
    try { expect(result.durationMs).toBe(expected); }
    finally { if ('release' in result && typeof result.release === 'function') await result.release(); }
    expect(await workspaces()).toEqual([]);
  });

  it.each([undefined, 'first-valid'] as const)('preserves first-valid behavior when policy is %s', async durationSource => {
    await writeFile(join(directory, 'state.json'), JSON.stringify({ probe: {
      format: { format_name: 'matroska', duration: 'N/A' }, streams: [audio, video],
    } }));
    const input = request({ kind: 'bytes', data: bytes }, durationSource === undefined ? {} : { durationSource });
    const result = entry === 'probeMedia' ? await probeMedia(input) : await prepareMediaProbe(input);
    try { expect(result.durationMs).toBe(2000); }
    finally { if ('release' in result && typeof result.release === 'function') await result.release(); }
    expect(await workspaces()).toEqual([]);
  });

  it('rejects an unknown duration source policy before reading media', async () => {
    const pull = vi.fn();
    const input = { ...request({ kind: 'stream', stream: new ReadableStream({ pull }, { highWaterMark: 0 }) }), durationSource: 'unknown' };
    const run = entry === 'probeMedia' ? probeMedia : prepareMediaProbe;
    await expect(run(input as unknown as ProbeMediaRequest)).rejects.toMatchObject({ code: 'config_invalid' });
    expect(pull).not.toHaveBeenCalled();
    expect(await workspaces()).toEqual([]);
  });
});

describe('prepareMediaProbe', () => {
  it('consumes the source once and retains identical bytes and checksum until release after the prepare deadline', async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(bytes); controller.close(); } }, { highWaterMark: 0 });
    const prepared = await prepareMediaProbe(request({ kind: 'stream', stream }, { deadlineMs: 500 }));
    try {
      expect(pulls).toBe(1);
      expect(stream.locked).toBe(false);
      expect(prepared.byteLength).toBe(bytes.length);
      expect(prepared.inputChecksum).toEqual({ algorithm: 'sha256', value: createHash('sha256').update(bytes).digest('hex') });
      await new Promise(resolve => setTimeout(resolve, 550));
      expect((await stat(prepared.filePath)).size).toBe(bytes.length);
      expect(new Uint8Array(await new Response(prepared.body).arrayBuffer())).toEqual(bytes);
    } finally { await prepared.release(); }
    await expect(stat(prepared.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('snapshots caller files and never deletes the source during concurrent idempotent release', async () => {
    const source = join(directory, 'original.bin');
    await writeFile(source, bytes);
    const prepared = await prepareMediaProbe(request({ kind: 'file', path: source }));
    expect(prepared.filePath).not.toBe(source);
    await Promise.all([prepared.release(), prepared.release(), prepared.release()]);
    expect(new Uint8Array(await readFile(source))).toEqual(bytes);
    expect(await workspaces()).toEqual([]);
  });

  it('keeps the returned body bound to the caller signal after preparation succeeds', async () => {
    const controller = new AbortController();
    const prepared = await prepareMediaProbe(request({ kind: 'bytes', data: bytes }, { signal: controller.signal }));
    try {
      controller.abort();
      await expect(new Response(prepared.body).arrayBuffer()).rejects.toBeInstanceOf(Error);
    } finally { await prepared.release(); }
    expect(await workspaces()).toEqual([]);
  });

  it.each([0, 2, 4, 512 * 1024 * 1024 + 1])('rejects actual content mismatching declared length %s without an implicit size cap', async declaredByteLength => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    await expect(prepareMediaProbe(request({ kind: 'stream', stream, declaredByteLength })))
      .rejects.toMatchObject({ code: 'constraint_unsatisfied' });
    expect(stream.locked).toBe(false);
    expect(await workspaces()).toEqual([]);
  });

  it('rejects an explicit byte limit before pulling an over-budget declared source', async () => {
    const pull = vi.fn(); const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    await expect(prepareMediaProbe(request({ kind: 'stream', stream, declaredByteLength: 3 }, { maxInputBytes: 2 })))
      .rejects.toMatchObject({ code: 'input_too_large' });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(await workspaces()).toEqual([]);
  });

  it.each(['empty', 'corrupt'])('cleans staged files after %s media fails', async failure => {
    if (failure === 'corrupt') await mode('corrupt');
    await expect(prepareMediaProbe(request({ kind: 'bytes', data: failure === 'empty' ? new Uint8Array() : bytes })))
      .rejects.toMatchObject({ code: 'unavailable' });
    expect(await workspaces()).toEqual([]);
  });

  it('cancels a stalled source read and releases its lock and workspace', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const admitted = new Promise<void>(resolve => { started = resolve; });
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull: started, cancel }, { highWaterMark: 0 });
    const pending = prepareMediaProbe(request({ kind: 'stream', stream }, { signal: controller.signal }));
    void pending.catch(() => undefined);
    await Promise.race([admitted, pending]);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(await workspaces()).toEqual([]);
  });

  it('bounds a stalled source by the total preparation deadline', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    await expect(prepareMediaProbe(request({ kind: 'stream', stream }, { deadlineMs: 100 })))
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(await workspaces()).toEqual([]);
  });

  it('rejects a successful probe parsed after its deadline before the timer can run', async () => {
    let now = 0;
    const parse = JSON.parse;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const parsing = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      const value = parse(text, reviver);
      if (value?.format?.format_name === 'mov,mp4') now = 2_001;
      return value;
    });
    try {
      const result = await prepareMediaProbe(request({ kind: 'bytes', data: bytes }))
        .then(value => ({ value }), error => ({ error }));
      if ('value' in result) await result.value.release();
      expect(now).toBe(2_001);
      expect(result).toMatchObject({ error: { code: 'cancelled', message: 'deadline exceeded' } });
      expect(await workspaces()).toEqual([]);
    } finally { parsing.mockRestore(); clock.mockRestore(); }
  });

  it('cancels an unread source if a temporary workspace cannot be created', async () => {
    io.mkdtemp.mockRejectedValueOnce(new Error('temporary disk unavailable'));
    const pull = vi.fn(); const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    await expect(prepareMediaProbe(request({ kind: 'stream', stream }))).rejects.toThrow('temporary disk unavailable');
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(await workspaces()).toEqual([]);
  });

  it('allows a separate probe timeout and cleans the snapshot when ffprobe stalls', async () => {
    await mode('sleep');
    await expect(prepareMediaProbe(request({ kind: 'bytes', data: bytes }, { probeTimeoutMs: 100 })))
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(await workspaces()).toEqual([]);
  });

  it.each(['stdout', 'stderr'])('kills and reaps ffprobe when %s exceeds one million bytes', async output => {
    await mode(output);
    await expect(prepareMediaProbe(request({ kind: 'bytes', data: bytes }, { maxOutputBytes: 1_000_000 })))
      .rejects.toMatchObject({ code: 'unavailable' });
    const pid = Number(await readFile(join(directory, 'pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await workspaces()).toEqual([]);
  });

  it('finds a bare ffprobe on PATH without requiring an ffmpeg binary', async () => {
    vi.stubEnv('PATH', `${directory}:${process.env.PATH ?? ''}`);
    const prepared = await prepareMediaProbe(request({ kind: 'bytes', data: bytes }, { ffmpegPath: undefined, ffprobePath: 'ffprobe-test.cjs' }));
    try { expect(prepared.video).toMatchObject({ width: 160, height: 90 }); }
    finally { await prepared.release(); }
  });
});
