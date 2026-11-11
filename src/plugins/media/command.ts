import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { StorageError } from '../../core/errors.js';

const STATIC_CODEC: Readonly<Record<string, string>> = {
  libx264: 'h264',
  libx264rgb: 'h264',
  aac: 'aac',
  aac_at: 'aac',
  libmp3lame: 'mp3',
  png: 'png',
  apng: 'apng',
  libvpx: 'vp8',
  'libvpx-vp9': 'vp9',
  libopus: 'opus',
  mpeg4: 'mpeg4',
  pcm_s16le: 'pcm_s16le',
};

export type Budget = Readonly<{
  deadlineMs: number;
  startedAt: number;
  signal: AbortSignal;
}>;

export type CommandResult = Readonly<{
  stdout: Buffer;
  stderr: Buffer;
}>;

export function createBudget(deadlineMs: number, signal: AbortSignal): Budget {
  if (signal.aborted) throw new StorageError('cancelled', 'operation cancelled');
  return { deadlineMs, startedAt: Date.now(), signal };
}

export function remainingMs(budget: Budget): number {
  if (budget.signal.aborted) throw new StorageError('cancelled', 'operation cancelled');
  const left = budget.deadlineMs - (Date.now() - budget.startedAt);
  if (left <= 0) throw new StorageError('cancelled', 'deadline exceeded');
  return left;
}

export async function assertExecutable(filePath: string): Promise<void> {
  try {
    await access(filePath, constants.X_OK);
  } catch {
    throw new StorageError('capability_unsupported', `media tool is not executable: ${filePath}`);
  }
}

export function parseEncoders(text: string): Map<string, string | null> {
  const found = new Map<string, string | null>();
  for (const line of text.split('\n')) {
    const match = /^[ \t]*([VAS][A-Z.]{5})[ \t]+([A-Za-z0-9_-]+)/.exec(line);
    const name = match?.[2];
    if (!name) continue;
    const hinted = /\(codec\s+([A-Za-z0-9_-]+)\)/.exec(line)?.[1] ?? null;
    found.set(name, hinted);
  }
  return found;
}

export function outputCodec(encoder: string, hints: ReadonlyMap<string, string | null>): string | null {
  return hints.get(encoder) ?? STATIC_CODEC[encoder] ?? null;
}

export async function assertEncoders(
  ffmpegPath: string,
  encoders: readonly string[],
  budget: Budget,
): Promise<Map<string, string | null>> {
  const { stdout } = await runCommand(ffmpegPath, ['-hide_banner', '-encoders'], {
    timeoutMs: remainingMs(budget),
    signal: budget.signal,
  });
  const available = parseEncoders(stdout.toString('utf8'));
  for (const encoder of encoders) {
    if (!available.has(encoder)) {
      throw new StorageError('capability_unsupported', `encoder is not available: ${encoder}`);
    }
    if (!outputCodec(encoder, available)) {
      throw new StorageError('config_invalid', `encoder cannot be verified: ${encoder}`);
    }
  }
  return available;
}

export function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

export function runCommand(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; signal: AbortSignal },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new StorageError('cancelled', 'operation cancelled'));
      return;
    }
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      reject(new StorageError('cancelled', 'deadline exceeded'));
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(spawnFailure(error));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let reason: StorageError | null = null;

    const stopTimer = () => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
    };

    const killChild = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };

    const onAbort = () => {
      reason ??= new StorageError('cancelled', 'operation cancelled');
      killChild();
    };

    // Reap the child before rejecting so a timed-out ffmpeg does not outlive the call.
    const timer = setTimeout(() => {
      reason ??= new StorageError('cancelled', 'deadline exceeded');
      killChild();
    }, Math.ceil(options.timeoutMs));

    options.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout.push(Buffer.from(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr.push(Buffer.from(chunk));
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      stopTimer();
      killChild();
      reject(spawnFailure(error));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      stopTimer();
      if (reason) {
        reject(reason);
        return;
      }
      if (signal) {
        reject(new StorageError('cancelled', 'media tool was killed'));
        return;
      }
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
        return;
      }
      const detail = Buffer.concat(stderr).toString('utf8').trim().slice(-400);
      reject(new StorageError('unavailable', detail.length > 0 ? `media tool exited ${code}: ${detail}` : `media tool exited ${code}`));
    });
  });
}

function spawnFailure(error: unknown): StorageError {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === 'ENOENT' || code === 'EACCES') {
    return new StorageError('capability_unsupported', 'media tool is not executable');
  }
  return new StorageError('unavailable', 'media tool failed to start');
}
