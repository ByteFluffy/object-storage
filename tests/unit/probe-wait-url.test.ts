import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForUrl } from '../../src/plugins/probe/index.js';

const options = {
  url: 'https://media.example/generated/video.mp4',
  method: 'HEAD' as const,
  signatureMethod: 'unsigned' as const,
  verification: 'availability' as const,
  intervalMs: 500,
  deadlineMs: 2_000,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe('waitForUrl', () => {
  it('checks immediately and returns an available URL without leaving timers', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const result = await waitForUrl({ ...options, fetch });
    expect(result).toMatchObject({ status: 'passed', httpStatus: 200 });
    expect(result.checksum).toBeUndefined();
    expect(Date.now()).toBe(0);
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits exactly the configured 500ms between a missing URL and the next check', async () => {
    const times: number[] = [];
    const fetch = vi.fn(async () => {
      times.push(Date.now());
      return new Response(null, { status: times.length === 1 ? 404 : 200 });
    });
    const result = waitForUrl({ ...options, fetch });
    await vi.advanceTimersByTimeAsync(499);
    expect(times).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ status: 'passed' });
    expect(times).toEqual([0, 500]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts the interval after the previous check finishes, without overlapping requests', async () => {
    const times: number[] = [];
    const fetch = vi.fn(() => {
      times.push(Date.now());
      return times.length === 1
        ? new Promise<Response>(resolve => setTimeout(() => resolve(new Response(null, { status: 404 })), 100))
        : Promise.resolve(new Response(null, { status: 200 }));
    });
    const result = waitForUrl({ ...options, fetch });
    await vi.advanceTimersByTimeAsync(599);
    expect(times).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ status: 'passed' });
    expect(times).toEqual([0, 600]);
  });

  it('uses a caller interval other than 500ms and releases its abort listener after success', async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const result = waitForUrl({ ...options, fetch, intervalMs: 75, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(74);
    expect(fetch).toHaveBeenCalledOnce();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ status: 'passed' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([404, 408, 429, 500, 503, 599])('retries temporary HTTP %s at the configured interval', async status => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const result = waitForUrl({ ...options, fetch });
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toMatchObject({ status: 'passed', httpStatus: 200 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([301, 302, 307, 400, 401, 403, 410, 418, 422])('stops immediately on permanent HTTP %s', async status => {
    const fetch = vi.fn(async () => new Response(null, { status }));
    const result = await waitForUrl({ ...options, fetch });
    expect(result.httpStatus).toBe(status);
    expect(result.status).not.toBe('passed');
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry a successful HTTP response with the wrong media type', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(waitForUrl({ ...options, fetch, expectedMediaType: 'video/mp4' }))
      .resolves.toMatchObject({ status: 'mismatch', mediaType: 'text/html' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries transport failures reported by checkUrl', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const result = waitForUrl({ ...options, fetch });
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toMatchObject({ status: 'passed' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reaches a non-integral deadline without checking again at or after it', async () => {
    const times: number[] = [];
    const fetch = vi.fn(async () => {
      times.push(Date.now());
      return new Response(null, { status: 404 });
    });
    let settled = false;
    const result = waitForUrl({ ...options, fetch, deadlineMs: 1_250 }).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(1_249);
    expect(settled).toBe(false);
    expect(times).toEqual([0, 500, 1_000]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ status: 'timed_out', checkedAt: '1970-01-01T00:00:01.250Z' });
    expect(times).toEqual([0, 500, 1_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a request with no time remaining', async () => {
    const fetch = vi.fn();
    await expect(waitForUrl({ ...options, fetch, deadlineMs: 0 })).resolves.toMatchObject({ status: 'timed_out' });
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects success observed beyond the deadline even when its timer has not run', async () => {
    let now = 0;
    const fetch = vi.fn(async () => {
      now = 100;
      return new Response(null, { status: 200 });
    });
    await expect(waitForUrl({ ...options, fetch, deadlineMs: 50, now: () => now }))
      .resolves.toMatchObject({ status: 'timed_out' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts an in-flight request at the total deadline even if fetch ignores the signal', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init: { signal?: AbortSignal }) => {
      requestSignal = init.signal;
      return new Promise<Response>(() => {});
    });
    const result = waitForUrl({ ...options, fetch, deadlineMs: 750, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(750);
    await expect(result).resolves.toMatchObject({ status: 'timed_out' });
    expect(requestSignal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not fetch when already cancelled', async () => {
    const fetch = vi.fn();
    await expect(waitForUrl({ ...options, fetch, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'cancelled' });
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the interval wait and removes scheduled checks', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    const result = waitForUrl({ ...options, fetch, signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ code: 'cancelled' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight request even when fetch ignores the signal', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init: { signal?: AbortSignal }) => {
      requestSignal = init.signal;
      return new Promise<Response>(() => {});
    });
    const result = waitForUrl({ ...options, fetch, signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ code: 'cancelled' });
    controller.abort();
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives cancellation priority when the same request reports HTTP 200', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => {
      controller.abort();
      return new Response(null, { status: 200 });
    });
    await expect(waitForUrl({ ...options, fetch, signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, NaN, Infinity])('rejects invalid interval %s before fetching', async intervalMs => {
    const fetch = vi.fn();
    await expect(waitForUrl({ ...options, fetch, intervalMs })).rejects.toMatchObject({ code: 'config_invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([-1, NaN, Infinity])('rejects invalid deadline %s before fetching', async deadlineMs => {
    const fetch = vi.fn();
    await expect(waitForUrl({ ...options, fetch, deadlineMs })).rejects.toMatchObject({ code: 'config_invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves a signed HEAD URL and its method binding', async () => {
    const url = 'https://media.example/video.mp4?signature=secret';
    const fetch = vi.fn(async (_url: string) => new Response(null, { status: 200 }));
    await expect(waitForUrl({ ...options, fetch, url, signatureMethod: 'HEAD' })).resolves.toMatchObject({ status: 'passed' });
    expect(fetch.mock.calls[0]?.[0]).toBe(url);
  });

  it('does not retry unsigned query strings or expose their signature', async () => {
    const fetch = vi.fn();
    const error = await waitForUrl({ ...options, fetch, url: 'https://media.example/video.mp4?signature=secret' })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'config_invalid' });
    expect((error as Error).message).not.toContain('secret');
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
