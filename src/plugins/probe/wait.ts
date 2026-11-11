import { StorageError } from '../../core/errors.js';
import type { ProbeResult, ProbeStatus } from '../../core/plugin.js';

/**
 * Replica readiness is event-driven. The host emits check or timeout events
 * from a queue or a bucket notification. This module does not sleep.
 */
export type ReplicaEvent = Readonly<{ type: 'check' } | { type: 'timeout' }>;

export type ReplicaDecision =
  | Readonly<{ type: 'settled'; result: ProbeResult }>
  | Readonly<{ type: 'stopped'; result: ProbeResult }>
  | Readonly<{ type: 'pending'; result: ProbeResult; waitForNextEvent: boolean }>;

const STOP: ReadonlySet<ProbeStatus> = new Set(['forbidden', 'mismatch', 'redirected']);

export function decideReplica(
  result: ProbeResult,
  timing: Readonly<{ now: number; deadlineAt: number; intervalMs: number }>,
): ReplicaDecision {
  if (result.status === 'passed') return { type: 'settled', result };
  if (STOP.has(result.status) || result.status === 'timed_out') return { type: 'stopped', result };

  const nextAt = timing.now + timing.intervalMs;
  const pending: ProbeResult = { ...result, nextCheckAt: new Date(nextAt).toISOString() };
  return {
    type: 'pending',
    result: pending,
    waitForNextEvent: nextAt <= timing.deadlineAt,
  };
}

export async function followReplica(
  input: Readonly<{
    events: AsyncIterable<ReplicaEvent>;
    check: () => Promise<ProbeResult>;
    intervalMs: number;
    deadlineMs: number;
    now: () => number;
    signal?: AbortSignal;
  }>,
): Promise<ProbeResult> {
  const deadlineAt = input.now() + input.deadlineMs;
  let pending: ProbeResult | null = null;

  if (input.signal?.aborted) throw new StorageError('cancelled', 'operation cancelled');
  if (input.now() >= deadlineAt) return timedOut(input.now());

  for await (const event of input.events) {
    if (input.signal?.aborted) throw new StorageError('cancelled', 'operation cancelled');
    if (event.type === 'timeout' || input.now() >= deadlineAt) return timedOut(input.now());

    const result = await input.check();
    const decision = decideReplica(result, {
      now: input.now(),
      deadlineAt,
      intervalMs: input.intervalMs,
    });
    if (decision.type === 'settled' || decision.type === 'stopped') return decision.result;
    pending = decision.result;
    if (!decision.waitForNextEvent) return pending;
  }

  return pending ?? timedOut(input.now());
}

function timedOut(now: number): ProbeResult {
  return { status: 'timed_out', checkedAt: new Date(now).toISOString() };
}
