import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assertModeAllowed, clientOrderId, loadConfig, quoteFromMarket, runCycle, type RunnerDeps } from '../runner.js';
import { threshold } from '../examples/threshold.js';
import type { TradeLogRecord } from '../../audit/trade-log.js';
import type { V2OrderBody } from '../../tools/kalshi/orders-v2.js';
import type { KalshiMarket } from '../../tools/kalshi/types.js';

let dir: string;
let prevDemo: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'strategy-'));
  prevDemo = process.env.KALSHI_USE_DEMO;
  process.env.KALSHI_USE_DEMO = 'true';
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env.KALSHI_USE_DEMO = prevDemo;
});

function writeConfig(over: Record<string, unknown> = {}): void {
  writeFileSync(join(dir, 'bot.json'), JSON.stringify({ ...threshold.exampleConfig(), tickers: ['KX-A', 'KX-B'], ...over }));
}

const MARKETS = [
  { ticker: 'KX-A', status: 'active', yes_bid_dollars: '0.3800', yes_ask_dollars: '0.4000', no_bid_dollars: '0.6000', no_ask_dollars: '0.6200', close_time: '2027-01-01T00:00:00Z' },
  { ticker: 'KX-B', status: 'active', yes_bid_dollars: '0.3700', yes_ask_dollars: '0.3900', close_time: '2027-01-01T00:00:00Z' },
];

interface Fake {
  deps: RunnerDeps;
  calls: string[];
  placed: V2OrderBody[];
  logs: Array<Omit<TradeLogRecord, 'ts' | 'env'>>;
}

function fake(opts: { resting?: unknown[]; fills?: unknown[]; positions?: unknown[] } = {}): Fake {
  const f: Fake = { calls: [], placed: [], logs: [], deps: undefined as unknown as RunnerDeps };
  f.deps = {
    api: async (method, path) => {
      f.calls.push(`${method} ${path}`);
      if (path === '/markets') return { markets: MARKETS };
      if (path === '/portfolio/positions') return { market_positions: opts.positions ?? [] };
      if (path === '/portfolio/orders') return { orders: opts.resting ?? [] };
      if (path === '/portfolio/balance') return { balance: 5000 };
      if (path === '/portfolio/fills') return { fills: opts.fills ?? [] };
      throw new Error(`unexpected ${path}`);
    },
    placeOrder: async (body) => { f.placed.push(body); return { order: { order_id: `ord-${f.placed.length}` } }; },
    cancelOrder: async () => ({}),
    log: { record: (e) => { f.logs.push(e); } },
    now: () => new Date('2026-10-31T12:00:00Z'),
    dir,
  };
  return f;
}

describe('runCycle', () => {
  it('dry-run decides but sends nothing, and logs the cycle', async () => {
    writeConfig();
    const f = fake();
    const r = await runCycle(loadConfig(dir, 'bot'), { mode: 'dry-run' }, f.deps);

    expect(r.error).toBeUndefined();
    expect(f.placed).toEqual([]);
    expect(r.results.map((x) => x.status)).toEqual(['dry-run', 'dry-run']);
    const decision = f.logs.find((l) => l.action === 'decision')!;
    expect(decision).toMatchObject({ strategy: 'threshold', config: 'bot', cycle: 1, mode: 'dry-run', outcome: 'ok' });
  });

  it('live mode places orders with deterministic client order ids', async () => {
    writeConfig();
    const f = fake();
    const r = await runCycle(loadConfig(dir, 'bot'), { mode: 'live' }, f.deps);

    expect(f.placed.map((b) => [b.ticker, b.side, b.price, b.time_in_force])).toEqual([
      ['KX-A', 'bid', '0.4000', 'immediate_or_cancel'],
      ['KX-B', 'bid', '0.3900', 'immediate_or_cancel'],
    ]);
    expect(f.placed[0].client_order_id).toBe(clientOrderId('bot', 1, r.decisions[0] as never));
    expect(r.results.map((x) => x.orderId)).toEqual(['ord-1', 'ord-2']);
  });

  it('caps orders per cycle', async () => {
    writeConfig({ maxOrdersPerCycle: 1 });
    const f = fake();
    const r = await runCycle(loadConfig(dir, 'bot'), { mode: 'live' }, f.deps);
    expect(f.placed).toHaveLength(1);
    expect(r.results[1]).toMatchObject({ status: 'skipped', note: expect.stringContaining('maxOrdersPerCycle') });
  });

  it('records a mandate refusal without stopping the cycle', async () => {
    writeConfig();
    const f = fake();
    f.deps.placeOrder = async () => {
      const err = new Error('Order refused by mandate: kill switch is ACTIVE');
      err.name = 'MandateViolation';
      throw err;
    };
    const r = await runCycle(loadConfig(dir, 'bot'), { mode: 'live' }, f.deps);
    expect(r.error).toBeUndefined();
    expect(r.results.map((x) => x.status)).toEqual(['refused', 'refused']);
  });

  it('keeps a bounded call budget per cycle', async () => {
    writeConfig();
    const f = fake();
    const r = await runCycle(loadConfig(dir, 'bot'), { mode: 'dry-run' }, f.deps);
    expect(f.calls).toEqual(['GET /markets', 'GET /portfolio/positions', 'GET /portfolio/orders', 'GET /portfolio/balance', 'GET /portfolio/fills']);
    expect(r.apiCalls).toBe(5);
  });

  it('logs each new fill once across cycles and advances the cycle counter', async () => {
    writeConfig();
    const fills = [{ fill_id: 'f1', ticker: 'KX-A', ts: 1793460000 }, { fill_id: 'f2', ticker: 'KX-B', ts: 1793460001 }];
    const f = fake({ fills });
    const cfg = loadConfig(dir, 'bot');

    const first = await runCycle(cfg, { mode: 'dry-run' }, f.deps);
    const second = await runCycle(cfg, { mode: 'dry-run' }, f.deps);

    expect(first.newFills).toBe(2);
    expect(second.newFills).toBe(0);
    expect(second.cycle).toBe(2);
    expect(f.logs.filter((l) => l.action === 'fill').map((l) => (l.detail as { fill_id: string }).fill_id)).toEqual(['f1', 'f2']);
  });

  it('reports an API failure in the result and the log instead of throwing', async () => {
    writeConfig();
    const f = fake();
    f.deps.api = async () => { throw new Error('Kalshi API error: 503'); };
    const r = await runCycle(loadConfig(dir, 'bot'), { mode: 'live' }, f.deps);
    expect(r.error).toContain('503');
    expect(f.logs.at(-1)).toMatchObject({ action: 'decision', outcome: 'error' });
  });
});

describe('loadConfig', () => {
  it('names the file and field on a bad config', () => {
    writeConfig({ side: 'maybe' });
    expect(() => loadConfig(dir, 'bot')).toThrow(/bot\.json: side must be/);
  });

  it('rejects config names that could escape the folder', () => {
    expect(() => loadConfig(dir, '../etc')).toThrow('may only use');
  });
});

describe('assertModeAllowed', () => {
  it('refuses live on production without --allow-prod', () => {
    process.env.KALSHI_USE_DEMO = 'false';
    expect(() => assertModeAllowed('live', false)).toThrow('PRODUCTION');
    expect(() => assertModeAllowed('live', true)).not.toThrow();
    expect(() => assertModeAllowed('dry-run', false)).not.toThrow();
  });
});

describe('quoteFromMarket', () => {
  it('prefers dollar strings, derives missing NO quotes, and blanks empty books', () => {
    const q = quoteFromMarket({ ticker: 'KX', status: 'active', yes_bid_dollars: '0.0000', yes_ask_dollars: '0.4100' } as KalshiMarket);
    expect(q.yesAsk).toBe(41);
    expect(q.noBid).toBe(59);
    expect(Number.isNaN(q.yesBid)).toBe(true);
    expect(Number.isNaN(q.noAsk)).toBe(true);
  });
});
