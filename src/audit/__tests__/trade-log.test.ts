import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TradeLog, localDate, tradeLog } from '../trade-log.js';
import * as mandate from '../../risk/mandate.js';
import { buildV2Order, placeOrderV2, cancelOrderV2 } from '../../tools/kalshi/orders-v2.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'trade-log-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readLines(file: string): Record<string, unknown>[] {
  return readFileSync(join(dir, file), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
}

describe('TradeLog', () => {
  it('writes one file per local day', () => {
    const log = new TradeLog(dir);
    log.record({ action: 'cancel', outcome: 'ok', order_ids: ['a'] }, new Date(2026, 9, 31, 23, 59));
    log.record({ action: 'cancel', outcome: 'ok', order_ids: ['b'] }, new Date(2026, 10, 1, 0, 1));
    log.record({ action: 'cancel', outcome: 'ok', order_ids: ['c'] }, new Date(2026, 10, 1, 9, 0));

    expect(readdirSync(dir).sort()).toEqual(['2026-10-31.jsonl', '2026-11-01.jsonl']);
    expect(readLines('2026-11-01.jsonl').map((r) => r.order_ids)).toEqual([['b'], ['c']]);
  });

  it('stamps ts and env on every line', () => {
    const prev = process.env.KALSHI_USE_DEMO;
    process.env.KALSHI_USE_DEMO = 'true';
    try {
      const now = new Date(2026, 9, 31, 12, 0);
      new TradeLog(dir).record({ action: 'place', outcome: 'refused', error: 'kill switch' }, now);
      const [line] = readLines(`${localDate(now)}.jsonl`);
      expect(line).toMatchObject({ ts: now.toISOString(), env: 'demo', action: 'place', outcome: 'refused' });
    } finally {
      process.env.KALSHI_USE_DEMO = prev;
    }
  });

  it('never throws when the directory is unwritable', () => {
    const log = new TradeLog('/dev/null/not-a-dir');
    expect(() => log.record({ action: 'cancel', outcome: 'ok' })).not.toThrow();
  });
});

describe('order functions log to the daily trade log', () => {
  let recordSpy: ReturnType<typeof spyOn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    recordSpy = spyOn(tradeLog, 'record').mockImplementation(() => {});
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('network blocked in tests');
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    recordSpy.mockRestore();
    globalThis.fetch = originalFetch;
  });

  it('records a mandate refusal as refused, without sending', async () => {
    const enforce = spyOn(mandate, 'enforceMandate').mockImplementation(() => {
      throw new mandate.MandateViolation(['kill switch is ACTIVE']);
    });
    try {
      const body = buildV2Order({ ticker: 'KX-TEST', action: 'buy', side: 'yes', count: 1, priceCents: 5 });
      await expect(placeOrderV2(body)).rejects.toThrow('kill switch');
      expect(recordSpy).toHaveBeenCalledTimes(1);
      expect(recordSpy.mock.calls[0][0]).toMatchObject({ action: 'place', outcome: 'refused', orders: [body] });
    } finally {
      enforce.mockRestore();
    }
  });

  it('records an exchange failure as error', async () => {
    await expect(cancelOrderV2('ord-1')).rejects.toThrow();
    expect(recordSpy.mock.calls[0][0]).toMatchObject({ action: 'cancel', outcome: 'error', order_ids: ['ord-1'] });
  });
});
