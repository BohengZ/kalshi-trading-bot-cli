/**
 * Strategy runner: one cycle = snapshot → decide → reconcile → execute →
 * collect fills → log.
 *
 * Modes: dry-run decides only; paper reads live quotes but fills orders
 * against a simulated book (no account reads, no orders); live sends orders.
 *
 * Each cycle costs a fixed handful of reads (markets in chunks, positions,
 * resting orders, balance, fills) plus one write per order, and every call
 * goes through callKalshiApi's rate limiter. Orders go through placeOrderV2 /
 * cancelOrderV2, so the mandate, kill switch and daily trade log apply to
 * strategy orders exactly as to manual ones.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callKalshiApi, type KalshiApiResponse } from '../tools/kalshi/api.js';
import { buildV2Order, cancelOrderV2, placeOrderV2, type V2OrderBody } from '../tools/kalshi/orders-v2.js';
import { netPosition } from '../tools/kalshi/positions.js';
import { parsePriceField, getVolume24h } from '../risk/kelly.js';
import { tradeLog as defaultTradeLog, type TradeLog } from '../audit/trade-log.js';
import { appPath } from '../utils/paths.js';
import type { KalshiMarket, KalshiOrder, KalshiPosition } from '../tools/kalshi/types.js';
import type { Decision, MarketQuote, RestingOrder, Snapshot, Strategy } from './types.js';
import { getStrategy } from './registry.js';
import { bookPositions, newBook, settle, simulate, summarize, type PaperBook, type PaperFill, type PaperSummary } from './paper.js';

const MARKET_CHUNK = 50;
const DEFAULT_MAX_ORDERS_PER_CYCLE = 5;
const DEFAULT_PAPER_CASH_CENTS = 10_000;
const SEEN_FILL_IDS_KEPT = 500;

export type Mode = 'dry-run' | 'paper' | 'live';

type ApiFn = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  options?: { params?: Record<string, string | number | boolean | undefined> },
) => Promise<KalshiApiResponse>;

export interface RunnerDeps {
  api: ApiFn;
  placeOrder: (body: V2OrderBody) => Promise<KalshiApiResponse>;
  cancelOrder: (orderId: string) => Promise<KalshiApiResponse>;
  log: Pick<TradeLog, 'record'>;
  now: () => Date;
  dir: string;
}

export const defaultDeps = (): RunnerDeps => ({
  api: callKalshiApi as ApiFn,
  placeOrder: placeOrderV2,
  cancelOrder: cancelOrderV2,
  log: defaultTradeLog,
  now: () => new Date(),
  dir: appPath('strategies'),
});

// ─── Config + state files ──────────────────────────────────────────────────

export interface LoadedConfig {
  name: string;
  strategy: Strategy<any>;
  params: unknown;
  maxOrdersPerCycle: number;
  /** Starting cash for paper mode, in cents. */
  paperCashCents: number;
}

export function configPath(dir: string, name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Config name "${name}" may only use letters, digits, - and _`);
  return join(dir, `${name}.json`);
}

export function loadConfig(dir: string, name: string): LoadedConfig {
  const path = configPath(dir, name);
  if (!existsSync(path)) throw new Error(`No strategy config at ${path}. Create one with: kalshi strategy init ${name}`);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const strategy = getStrategy(String(raw.strategy ?? ''));
  const max = raw.maxOrdersPerCycle ?? DEFAULT_MAX_ORDERS_PER_CYCLE;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 0) throw new Error('maxOrdersPerCycle must be a whole number >= 0');
  const cash = raw.paperCashCents ?? DEFAULT_PAPER_CASH_CENTS;
  if (typeof cash !== 'number' || !Number.isInteger(cash) || cash <= 0) throw new Error('paperCashCents must be a whole number of cents > 0');
  try {
    return { name, strategy, params: strategy.validate(raw), maxOrdersPerCycle: max, paperCashCents: cash };
  } catch (err) {
    throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function writeExampleConfig(dir: string, name: string, strategyName: string): string {
  const path = configPath(dir, name);
  if (existsSync(path)) throw new Error(`${path} already exists — edit it, or pick another name`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(getStrategy(strategyName).exampleConfig(), null, 2) + '\n');
  return path;
}

export function listConfigs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.state.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

interface RunnerState {
  cycle: number;
  /** Unix seconds: fetch fills from here on. */
  fillsMinTs: number;
  seenFillIds: string[];
  /** Simulated book for paper mode; created on the first paper cycle. */
  paper?: PaperBook;
}

function statePath(dir: string, name: string): string {
  return join(dir, `${name}.state.json`);
}

function loadState(dir: string, name: string, now: Date): RunnerState {
  try {
    const s = JSON.parse(readFileSync(statePath(dir, name), 'utf-8'));
    if (typeof s.cycle === 'number' && typeof s.fillsMinTs === 'number' && Array.isArray(s.seenFillIds)) return s;
  } catch {
    // first run, or unreadable — start fresh from now
  }
  return { cycle: 0, fillsMinTs: Math.floor(now.getTime() / 1000), seenFillIds: [] };
}

/** Forget a config's cycle counter, fills cursor and paper book. */
export function resetState(dir: string, name: string): boolean {
  const path = statePath(dir, name);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

function saveState(dir: string, name: string, state: RunnerState): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(dir, name), JSON.stringify(state, null, 2) + '\n');
}

// ─── Snapshot ──────────────────────────────────────────────────────────────

function toCents(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 100) : NaN;
}

export function quoteFromMarket(m: KalshiMarket): MarketQuote {
  const yesBid = toCents(parsePriceField(m.yes_bid_dollars, m.dollar_yes_bid, m.yes_bid));
  const yesAsk = toCents(parsePriceField(m.yes_ask_dollars, m.dollar_yes_ask, m.yes_ask));
  let noBid = toCents(parsePriceField(m.no_bid_dollars, m.dollar_no_bid, m.no_bid));
  let noAsk = toCents(parsePriceField(m.no_ask_dollars, m.dollar_no_ask, m.no_ask));
  // A NO bid is a YES ask seen from the other side, and vice versa.
  if (!Number.isFinite(noBid) && Number.isFinite(yesAsk)) noBid = 100 - yesAsk;
  if (!Number.isFinite(noAsk) && Number.isFinite(yesBid)) noAsk = 100 - yesBid;
  // An empty book reports 0 (bid) or 100 (ask); treat those as no quote.
  const clean = (c: number) => (c >= 1 && c <= 99 ? c : NaN);
  return {
    ticker: m.ticker,
    status: m.status,
    yesBid: clean(yesBid),
    yesAsk: clean(yesAsk),
    noBid: clean(noBid),
    noAsk: clean(noAsk),
    last: clean(toCents(parsePriceField(m.last_price_dollars, m.dollar_last_price, m.last_price))),
    volume24h: getVolume24h(m),
    closeTime: m.close_time,
    result: m.result ?? '',
  };
}

function restingFromOrder(o: KalshiOrder): RestingOrder {
  const yes = parsePriceField(o.yes_price_dollars, undefined, o.yes_price);
  const no = parsePriceField(o.no_price_dollars, undefined, o.no_price);
  return {
    orderId: o.order_id,
    ticker: o.ticker,
    action: o.action,
    side: o.side,
    priceCents: toCents(o.side === 'no' ? no : yes),
    remaining: parseFloat(String(o.remaining_count_fp ?? o.remaining_count ?? '0')) || 0,
    clientOrderId: o.client_order_id,
  };
}

async function fetchQuotes(api: ApiFn, tickers: string[]): Promise<Record<string, MarketQuote>> {
  const markets: Record<string, MarketQuote> = {};
  for (let i = 0; i < tickers.length; i += MARKET_CHUNK) {
    const chunk = tickers.slice(i, i + MARKET_CHUNK);
    const data = await api('GET', '/markets', { params: { tickers: chunk.join(','), limit: chunk.length } });
    for (const m of (data.markets ?? []) as KalshiMarket[]) markets[m.ticker] = quoteFromMarket(m);
  }
  return markets;
}

async function takeSnapshot(api: ApiFn, tickers: string[], now: Date): Promise<Snapshot> {
  const markets = await fetchQuotes(api, tickers);

  const posData = await api('GET', '/portfolio/positions', { params: { limit: 1000 } });
  const positions: Record<string, number> = {};
  for (const p of (posData.market_positions ?? posData.positions ?? []) as KalshiPosition[]) {
    const n = netPosition(p);
    if (n !== 0) positions[p.ticker] = n;
  }

  const ordData = await api('GET', '/portfolio/orders', { params: { status: 'resting' } });
  const restingOrders = ((ordData.orders ?? []) as KalshiOrder[]).map(restingFromOrder);

  const bal = await api('GET', '/portfolio/balance');
  const cashCents = typeof bal.balance === 'number' ? bal.balance : Math.round(parseFloat(String(bal.balance_dollars ?? '0')) * 100);

  return { now, markets, positions, restingOrders, cashCents };
}

// ─── Reconcile + execute ───────────────────────────────────────────────────

/** Deterministic client_order_id, UUID-shaped: a resend of the same order is a duplicate Kalshi rejects. */
export function clientOrderId(config: string, cycle: number, d: Extract<Decision, { kind: 'place' }>): string {
  const h = createHash('sha256')
    .update([config, cycle, d.ticker, d.action, d.side, d.count, d.priceCents].join('|'))
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export interface SentResult {
  decision: Decision;
  status: 'sent' | 'dry-run' | 'paper-filled' | 'paper-unfilled' | 'skipped' | 'refused' | 'error';
  note?: string;
  orderId?: string;
}

export interface CycleResult {
  cycle: number;
  mode: Mode;
  env: 'demo' | 'prod';
  apiCalls: number;
  decisions: Decision[];
  results: SentResult[];
  newFills: number;
  /** Paper mode: the simulated book after this cycle. */
  paper?: PaperSummary;
  error?: string;
}

export interface CycleOptions {
  mode: Mode;
}

/** Run one cycle for a loaded config. Never throws: failures land in `error` and the log. */
export async function runCycle(cfg: LoadedConfig, opts: CycleOptions, deps: RunnerDeps = defaultDeps()): Promise<CycleResult> {
  const now = deps.now();
  const env = process.env.KALSHI_USE_DEMO === 'true' ? 'demo' : 'prod';
  let apiCalls = 0;
  const api: ApiFn = (...a) => { apiCalls++; return deps.api(...a); };

  const state = loadState(deps.dir, cfg.name, now);
  state.cycle += 1;
  const result: CycleResult = { cycle: state.cycle, mode: opts.mode, env, apiCalls: 0, decisions: [], results: [], newFills: 0 };
  let snapshot: Snapshot | undefined;
  const paper = opts.mode === 'paper';
  const book = paper ? (state.paper ??= newBook(cfg.paperCashCents)) : undefined;
  const logPaperFill = (fill: PaperFill) =>
    deps.log.record({ action: 'paper_fill', outcome: 'ok', strategy: cfg.strategy.name, config: cfg.name, cycle: state.cycle, mode: opts.mode, detail: fill }, now);

  try {
    if (book) {
      // Paper: quotes are the only exchange data; account state is the simulated book.
      const markets = await fetchQuotes(api, cfg.strategy.universe(cfg.params));
      for (const fill of settle(book, markets)) { result.newFills++; logPaperFill(fill); }
      snapshot = { now, markets, positions: bookPositions(book), restingOrders: [], cashCents: book.cashCents };
    } else {
      snapshot = await takeSnapshot(api, cfg.strategy.universe(cfg.params), now);
    }
    result.decisions = cfg.strategy.decide(snapshot, cfg.params);

    let placed = 0;
    for (const d of result.decisions) {
      if (d.kind === 'hold') continue;
      if (d.kind === 'place') {
        const dup = snapshot.restingOrders.some((o) =>
          o.ticker === d.ticker && o.action === d.action && o.side === d.side && o.priceCents === d.priceCents);
        if (dup) { result.results.push({ decision: d, status: 'skipped', note: 'identical order already resting' }); continue; }
        if (placed >= cfg.maxOrdersPerCycle) {
          result.results.push({ decision: d, status: 'skipped', note: `maxOrdersPerCycle (${cfg.maxOrdersPerCycle}) reached` });
          continue;
        }
        placed++;
      }
      if (opts.mode === 'dry-run') { result.results.push({ decision: d, status: 'dry-run' }); continue; }
      if (book) {
        if (d.kind === 'cancel') { result.results.push({ decision: d, status: 'skipped', note: 'paper orders never rest' }); continue; }
        const outcome = simulate(book, d, snapshot.markets[d.ticker]);
        if (outcome.filled) { result.newFills++; logPaperFill(outcome.fill); }
        result.results.push(outcome.filled
          ? { decision: d, status: 'paper-filled', note: `${outcome.fill.count} @ ${outcome.fill.priceCents}¢, fee ${outcome.fill.feeCents}¢` }
          : { decision: d, status: 'paper-unfilled', note: outcome.note });
        continue;
      }
      try {
        apiCalls++;
        if (d.kind === 'place') {
          const res = await deps.placeOrder(buildV2Order({
            ticker: d.ticker, action: d.action, side: d.side, count: d.count, priceCents: d.priceCents,
            timeInForce: d.timeInForce, clientOrderId: clientOrderId(cfg.name, state.cycle, d),
          }));
          const order = (res.order ?? res) as { order_id?: string };
          result.results.push({ decision: d, status: 'sent', orderId: order.order_id });
        } else {
          await deps.cancelOrder(d.orderId);
          result.results.push({ decision: d, status: 'sent', orderId: d.orderId });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.results.push({ decision: d, status: err instanceof Error && err.name === 'MandateViolation' ? 'refused' : 'error', note: message });
      }
    }

    if (book) {
      result.paper = summarize(book, snapshot.markets);
    } else {
      await collectFills();
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  async function collectFills(): Promise<void> {
    // Fills since the cursor: new trades from this or earlier cycles, or placed elsewhere.
    const fillData = await api('GET', '/portfolio/fills', { params: { min_ts: state.fillsMinTs, limit: 200 } });
    const seen = new Set(state.seenFillIds);
    let maxTs = state.fillsMinTs;
    for (const f of (fillData.fills ?? []) as Array<Record<string, unknown>>) {
      const id = String(f.fill_id ?? f.trade_id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      state.seenFillIds.push(id);
      result.newFills++;
      deps.log.record({ action: 'fill', outcome: 'ok', strategy: cfg.strategy.name, config: cfg.name, cycle: state.cycle, mode: opts.mode, detail: f }, now);
      const ts = typeof f.ts === 'number' ? f.ts : Math.floor(Date.parse(String(f.created_time)) / 1000);
      if (Number.isFinite(ts)) maxTs = Math.max(maxTs, ts);
    }
    // Same-second fills can straddle a poll, so keep min_ts at the last second seen and dedupe by id.
    state.fillsMinTs = maxTs;
    state.seenFillIds = state.seenFillIds.slice(-SEEN_FILL_IDS_KEPT);
  }

  result.apiCalls = apiCalls;
  deps.log.record({
    action: 'decision',
    outcome: result.error ? 'error' : 'ok',
    strategy: cfg.strategy.name,
    config: cfg.name,
    cycle: state.cycle,
    mode: opts.mode,
    ...(result.error ? { error: result.error } : {}),
    detail: {
      params: cfg.params,
      cash_cents: snapshot?.cashCents,
      quotes: snapshot ? cfg.strategy.universe(cfg.params).map((t) => snapshot!.markets[t] ?? { ticker: t, missing: true }) : undefined,
      positions: snapshot ? Object.fromEntries(cfg.strategy.universe(cfg.params).map((t) => [t, snapshot!.positions[t] ?? 0])) : undefined,
      resting_orders: snapshot?.restingOrders.filter((o) => cfg.strategy.universe(cfg.params).includes(o.ticker)),
      decisions: result.decisions,
      results: result.results.map((r) => ({ ticker: r.decision.ticker, kind: r.decision.kind, status: r.status, note: r.note, order_id: r.orderId })),
      new_fills: result.newFills,
      ...(result.paper ? { paper: result.paper } : {}),
      api_calls: apiCalls,
    },
  }, now);
  saveState(deps.dir, cfg.name, state);
  return result;
}

/** Live trading on production needs an explicit second opt-in. */
export function assertModeAllowed(mode: Mode, allowProd: boolean): void {
  if (mode === 'live' && process.env.KALSHI_USE_DEMO !== 'true' && !allowProd) {
    throw new Error('Refusing live trading on PRODUCTION (real money). Use demo (KALSHI_USE_DEMO=true), or pass --allow-prod.');
  }
}
