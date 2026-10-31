import { describe, it, expect } from 'bun:test';
import { TokenBucket, resolveTier } from '../rate-limit.js';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('TokenBucket', () => {
  it('lets a full bucket through, then paces at the rate', async () => {
    const c = clock();
    const b = new TokenBucket(10, 10, c.now);
    const sleeps: number[] = [];
    const sleep = async (ms: number) => { sleeps.push(ms); c.advance(ms); };

    for (let i = 0; i < 10; i++) await b.take(1, sleep);
    expect(sleeps).toEqual([]);

    await b.take(1, sleep);
    expect(sleeps).toEqual([100]);
  });

  it('refills continuously with elapsed time', () => {
    const c = clock();
    const b = new TokenBucket(10, 10, c.now);
    for (let i = 0; i < 10; i++) b.take(1);
    expect(b.waitMs(1)).toBe(100);
    c.advance(500);
    expect(b.waitMs(5)).toBe(0);
  });

  it('bills a batch per item and holds later calls until it is paid off', async () => {
    const c = clock();
    const b = new TokenBucket(5, 5, c.now);
    const sleep = async (ms: number) => { c.advance(ms); };

    await b.take(10, sleep); // larger than the bucket: waits for full, then goes into debt
    expect(b.waitMs(1)).toBe(1200); // 5 owed + 1 needed at 5/s
  });
});

describe('resolveTier', () => {
  it('falls back to basic for unknown values', () => {
    expect(resolveTier('expert')).toBe('expert');
    expect(resolveTier('platinum')).toBe('basic');
    expect(resolveTier(undefined)).toBe('basic');
  });
});
