/**
 * Daily trade log: one JSONL file per local calendar day under
 * ~/.kalshi-bot/trades/YYYY-MM-DD.jsonl, one line per order action
 * (place, batch place, amend, cancel, batch cancel) with its outcome, plus
 * the strategy runner's per-cycle decisions, the fills it picks up, and
 * simulated fills in paper mode.
 *
 * Written from the orders-v2 chokepoint so every path (CLI, TUI, agent,
 * strategy loops) is captured — including orders the mandate refused and
 * calls the exchange rejected. Built for later review/summarization, so
 * each line is self-contained. Logging never throws into the order path.
 */
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { appPath } from '../utils/paths.js';

export type TradeAction = 'place' | 'batch_place' | 'amend' | 'cancel' | 'batch_cancel' | 'decision' | 'fill' | 'paper_fill';
export type TradeOutcome = 'ok' | 'refused' | 'error';

export interface TradeLogRecord {
  ts: string; // ISO 8601 UTC
  env: 'demo' | 'prod';
  action: TradeAction;
  outcome: TradeOutcome;
  /** V2 order bodies sent (bid = buy YES, ask = sell YES; YES-side dollar price). */
  orders?: unknown[];
  order_ids?: string[];
  /** Exchange response on success. */
  response?: unknown;
  /** Refusal reason or exchange error on failure. */
  error?: string;
  /** Strategy runner context, on records written by `kalshi strategy run`. */
  strategy?: string;
  config?: string;
  cycle?: number;
  mode?: 'dry-run' | 'paper' | 'live';
  /** Free-form record body (decision: quotes, decisions, results; fill / paper_fill: the fill). */
  detail?: unknown;
}

/** Local calendar date as YYYY-MM-DD — the trader's day, not UTC's. */
export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export class TradeLog {
  constructor(private readonly dir: string = appPath('trades')) {}

  pathFor(d: Date): string {
    return join(this.dir, `${localDate(d)}.jsonl`);
  }

  record(entry: Omit<TradeLogRecord, 'ts' | 'env'>, now: Date = new Date()): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const line: TradeLogRecord = {
        ts: now.toISOString(),
        env: process.env.KALSHI_USE_DEMO === 'true' ? 'demo' : 'prod',
        ...entry,
      };
      appendFileSync(this.pathFor(now), JSON.stringify(line) + '\n');
    } catch {
      // A full disk or bad permissions must never block or fail an order.
    }
  }
}

export const tradeLog = new TradeLog();
