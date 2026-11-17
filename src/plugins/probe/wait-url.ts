import { StorageError } from '../../core/errors.js';
import type { ProbeResult } from '../../core/plugin.js';
import { checkUrl } from './url.js';
import { decideReplica } from './wait.js';

/** Wait for a URL without making the host own probe timers or retry decisions. */
export async function waitForUrl(
  input: Parameters<typeof checkUrl>[0] & Readonly<{ intervalMs: number; deadlineMs: number }>,
): Promise<ProbeResult> {
  const maximumDelay = 2_147_483_647;
  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs <= 0 || input.intervalMs > maximumDelay ||
      !Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 0 || input.deadlineMs > maximumDelay) {
    throw new StorageError('config_invalid', 'Probe intervals and deadlines must be valid timer durations');
  }

  const now = input.now ?? Date.now;
  const cancelled = new StorageError('cancelled', 'operation cancelled');
  if (input.signal?.aborted) throw cancelled;
  if (input.deadlineMs === 0) return { status: 'timed_out', checkedAt: new Date(now()).toISOString() };

  const controller = new AbortController();
  const deadline = new Error('Probe deadline reached');
  const abort = () => controller.abort(cancelled);
  let stopped!: () => void;
  const stopping = new Promise<never>((_resolve, reject) => {
    stopped = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', stopped, { once: true });
  });
  input.signal?.addEventListener('abort', abort, { once: true });
  const deadlineAt = now() + input.deadlineMs;
  const timeout = setTimeout(() => controller.abort(deadline), input.deadlineMs);
  let interval: ReturnType<typeof setTimeout> | undefined;

  try {
    while (true) {
      controller.signal.throwIfAborted();
      if (now() >= deadlineAt) return { status: 'timed_out', checkedAt: new Date(now()).toISOString() };
      let result: ProbeResult;
      try {
        result = await Promise.race([
          checkUrl({ ...input, signal: controller.signal }),
          stopping,
        ]);
      } catch (error) {
        controller.signal.throwIfAborted();
        if (!(error instanceof StorageError) || error.code !== 'unavailable') throw error;
        result = { status: 'unavailable', code: error.code, checkedAt: new Date(now()).toISOString() };
      }
      controller.signal.throwIfAborted();
      if (now() >= deadlineAt) {
        controller.abort(deadline);
        return { status: 'timed_out', checkedAt: new Date(now()).toISOString() };
      }
      const decision = decideReplica(result, { now: now(), deadlineAt, intervalMs: input.intervalMs });
      if (decision.type !== 'pending') return decision.result;

      // The total deadline also bounds the final, shorter interval and a stalled transport.
      await Promise.race([
        new Promise<void>(resolve => { interval = setTimeout(resolve, input.intervalMs); }),
        stopping,
      ]);
    }
  } catch (error) {
    if (input.signal?.aborted) throw cancelled;
    if (controller.signal.reason === deadline) return { status: 'timed_out', checkedAt: new Date(now()).toISOString() };
    throw error;
  } finally {
    clearTimeout(timeout);
    clearTimeout(interval);
    input.signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', stopped);
  }
}
