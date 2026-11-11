import { describe, expect, it } from 'vitest';
import { meetTargetSize, type TargetSize, type TargetSizePlan } from '../../src/plugins/image/target-size.js';

function planBytes(plan: TargetSizePlan): Uint8Array {
  return new Uint8Array(plan.quality * 10);
}

describe('meetTargetSize', () => {
  it('requires every target size field before encoding', async () => {
    let called = false;
    await expect(
      meetTargetSize({
        target: { maxOutputBytes: 10, qualityRange: [1, 5], maxAttempts: 2 } as unknown as TargetSize,
        width: 4,
        height: 4,
        encode: async () => {
          called = true;
          return new Uint8Array(1);
        },
      }),
    ).rejects.toMatchObject({ code: 'config_missing' });
    expect(called).toBe(false);
  });

  it.each([
    { maxOutputBytes: 0, qualityRange: [1, 5] as const, maxAttempts: 2, allowFurtherResize: false },
    { maxOutputBytes: 10, qualityRange: [80, 1] as const, maxAttempts: 2, allowFurtherResize: false },
    { maxOutputBytes: 10, qualityRange: [1, 5] as const, maxAttempts: 0, allowFurtherResize: false },
    { maxOutputBytes: 10, qualityRange: [1, 5] as const, maxAttempts: 2, allowFurtherResize: 'no' },
  ])('rejects an invalid target size %#', async (target) => {
    let called = false;
    await expect(
      meetTargetSize({
        target: target as unknown as TargetSize,
        width: 4,
        height: 4,
        encode: async () => {
          called = true;
          return new Uint8Array(1);
        },
      }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    expect(called).toBe(false);
  });

  it('rejects non-positive dimensions before encoding', async () => {
    let called = false;
    await expect(
      meetTargetSize({
        target: { maxOutputBytes: 10, qualityRange: [1, 2], maxAttempts: 1, allowFurtherResize: false },
        width: 0,
        height: 2,
        encode: async () => {
          called = true;
          return new Uint8Array(1);
        },
      }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    expect(called).toBe(false);
  });

  it('returns the highest quality that fits when the attempt budget is enough', async () => {
    const calls: TargetSizePlan[] = [];
    const result = await meetTargetSize({
      target: { maxOutputBytes: 50, qualityRange: [1, 10], maxAttempts: 10, allowFurtherResize: false },
      width: 8,
      height: 8,
      encode: async (plan) => {
        calls.push(plan);
        return planBytes(plan);
      },
    });

    expect(result.plan.quality).toBe(5);
    expect(result.data.byteLength).toBe(50);
    expect(result.attempts).toBe(calls.length);
    expect(result.attempts).toBeLessThanOrEqual(10);
    expect(calls.every((call) => call.width === 8 && call.height === 8)).toBe(true);
  });

  it('uses the minimum quality when that is the only attempt and the only one that fits', async () => {
    const result = await meetTargetSize({
      target: { maxOutputBytes: 15, qualityRange: [1, 10], maxAttempts: 1, allowFurtherResize: false },
      width: 8,
      height: 8,
      encode: async (plan) => planBytes(plan),
    });

    expect(result.plan).toEqual({ quality: 1, width: 8, height: 8 });
    expect(result.data.byteLength).toBe(10);
    expect(result.attempts).toBe(1);
  });

  it('does not encode more than maxAttempts', async () => {
    let calls = 0;
    await expect(
      meetTargetSize({
        target: { maxOutputBytes: 1, qualityRange: [1, 100], maxAttempts: 2, allowFurtherResize: true },
        width: 50,
        height: 50,
        encode: async () => {
          calls += 1;
          return new Uint8Array(10_000);
        },
      }),
    ).rejects.toMatchObject({ code: 'constraint_unsatisfied' });
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(2);
  });

  it('does not change dimensions when further resize is disabled', async () => {
    const calls: TargetSizePlan[] = [];
    await expect(
      meetTargetSize({
        target: { maxOutputBytes: 10, qualityRange: [1, 5], maxAttempts: 4, allowFurtherResize: false },
        width: 8,
        height: 8,
        encode: async (plan) => {
          calls.push(plan);
          return new Uint8Array(plan.width * plan.height * plan.quality);
        },
      }),
    ).rejects.toMatchObject({ code: 'constraint_unsatisfied' });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(calls.every((call) => call.width === 8 && call.height === 8)).toBe(true);
  });

  it('shrinks and stays within the byte limit when further resize is allowed', async () => {
    const calls: TargetSizePlan[] = [];
    const result = await meetTargetSize({
      target: { maxOutputBytes: 10, qualityRange: [1, 1], maxAttempts: 4, allowFurtherResize: true },
      width: 10,
      height: 10,
      encode: async (plan) => {
        calls.push(plan);
        return new Uint8Array(plan.width * plan.height);
      },
    });

    expect(result.data.byteLength).toBeLessThanOrEqual(10);
    expect(result.plan.width).toBeGreaterThanOrEqual(1);
    expect(result.plan.height).toBeGreaterThanOrEqual(1);
    expect(result.plan.width).toBeLessThan(10);
    expect(result.plan.height).toBeLessThan(10);
    expect(result.attempts).toBe(calls.length);
    expect(result.attempts).toBeLessThanOrEqual(4);
    expect(calls[0]).toEqual({ quality: 1, width: 10, height: 10 });
  });

  it('throws instead of returning an oversized image when shrinking cannot comply', async () => {
    const produced: number[] = [];
    await expect(
      meetTargetSize({
        target: { maxOutputBytes: 5, qualityRange: [1, 2], maxAttempts: 3, allowFurtherResize: true },
        width: 2,
        height: 2,
        encode: async () => {
          const data = new Uint8Array(50);
          produced.push(data.byteLength);
          return data;
        },
      }),
    ).rejects.toMatchObject({ code: 'constraint_unsatisfied' });
    expect(produced.some((size) => size > 5)).toBe(true);
  });
});
