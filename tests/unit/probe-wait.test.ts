import { describe, expect, it } from 'vitest';
import type { ProbeResult } from '../../src/core/plugin.js';
import { followReplica, type ReplicaEvent } from '../../src/plugins/probe/index.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function* checks(count: number): AsyncGenerator<ReplicaEvent> {
  for (let index = 0; index < count; index += 1) yield { type: 'check' };
}

describe('followReplica', () => {
  it('returns the first passed result without reading another event', async () => {
    let calls = 0;
    const passed: ProbeResult = { status: 'passed', checkedAt: '2024-01-02T03:04:05.000Z' };
    const result = await followReplica({
      events: checks(1),
      check: async () => {
        calls += 1;
        return passed;
      },
      intervalMs: 25,
      deadlineMs: 1_000,
      now: () => 0,
    });

    expect(result).toEqual(passed);
    expect(calls).toBe(1);
  });

  it('checks again only when the host emits another event', async () => {
    const seen: ProbeResult[] = [];
    const result = await followReplica({
      events: checks(2),
      check: async () => {
        const next: ProbeResult =
          seen.length === 0
            ? { status: 'not_found', checkedAt: '2024-01-02T00:00:00.000Z' }
            : { status: 'passed', checkedAt: '2024-01-02T00:00:01.000Z' };
        seen.push(next);
        return next;
      },
      intervalMs: 25,
      deadlineMs: 1_000,
      now: () => 0,
    });

    expect(result).toEqual({ status: 'passed', checkedAt: '2024-01-02T00:00:01.000Z' });
    expect(seen).toHaveLength(2);
  });

  it('times out before the first check when the deadline has already passed', async () => {
    let calls = 0;
    const result = await followReplica({
      events: checks(1),
      check: async () => {
        calls += 1;
        return { status: 'passed', checkedAt: 'unused' };
      },
      intervalMs: 10,
      deadlineMs: 0,
      now: () => 0,
    });

    expect(result.status).toBe('timed_out');
    expect(calls).toBe(0);
    expect(result.checkedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('does not check an event that arrives at the deadline', async () => {
    let now = 0;
    const seenAt: number[] = [];
    async function* events(): AsyncGenerator<ReplicaEvent> {
      yield { type: 'check' };
      now = 40;
      yield { type: 'check' };
      now = 80;
      yield { type: 'check' };
    }

    const result = await followReplica({
      events: events(),
      check: async () => {
        seenAt.push(now);
        return { status: 'not_found', checkedAt: '2024-01-02T00:00:00.000Z' };
      },
      intervalMs: 40,
      deadlineMs: 80,
      now: () => now,
    });

    expect(result.status).toBe('timed_out');
    expect(seenAt).toEqual([0, 40]);
  });

  it('returns nextCheckAt and stops when another interval would pass the deadline', async () => {
    let calls = 0;
    async function* events(): AsyncGenerator<ReplicaEvent> {
      yield { type: 'check' };
      throw new Error('no further event should be read');
    }

    const result = await followReplica({
      events: events(),
      check: async () => {
        calls += 1;
        return { status: 'not_found', checkedAt: '2024-01-02T00:00:00.000Z', byteLength: 4 };
      },
      intervalMs: 100,
      deadlineMs: 80,
      now: () => 0,
    });

    expect(calls).toBe(1);
    expect(result.status).toBe('not_found');
    expect(result.byteLength).toBe(4);
    expect(result.nextCheckAt).toMatch(ISO);
  });

  it('stops on a terminal probe result without waiting for another event', async () => {
    let calls = 0;
    async function* events(): AsyncGenerator<ReplicaEvent> {
      yield { type: 'check' };
      throw new Error('mismatch must not wait');
    }

    const result = await followReplica({
      events: events(),
      check: async () => {
        calls += 1;
        return { status: 'mismatch', checkedAt: '2024-01-02T00:00:00.000Z', code: 'checksum_mismatch' };
      },
      intervalMs: 10,
      deadlineMs: 1_000,
      now: () => 0,
    });

    expect(calls).toBe(1);
    expect(result).toMatchObject({ status: 'mismatch', code: 'checksum_mismatch' });
  });

  it('throws cancelled and does not check when the signal is already aborted', async () => {
    let calls = 0;
    await expect(
      followReplica({
        events: checks(1),
        check: async () => {
          calls += 1;
          return { status: 'passed', checkedAt: 'unused' };
        },
        intervalMs: 10,
        deadlineMs: 1_000,
        now: () => 0,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls).toBe(0);
  });

  it('does not check again when the signal aborts before the next event', async () => {
    const controller = new AbortController();
    let calls = 0;
    async function* events(): AsyncGenerator<ReplicaEvent> {
      yield { type: 'check' };
      controller.abort();
      yield { type: 'check' };
    }

    await expect(
      followReplica({
        events: events(),
        check: async () => {
          calls += 1;
          return { status: 'unavailable', checkedAt: '2024-01-02T00:00:00.000Z' };
        },
        intervalMs: 10,
        deadlineMs: 1_000,
        now: () => 0,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls).toBe(1);
  });
});
