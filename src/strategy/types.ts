/**
 * Deterministic strategy contract.
 *
 * A strategy is a pure function of (snapshot, params) → decisions. It does no
 * I/O and reads no clock or randomness except `snapshot.now`, so the same
 * inputs always give the same decisions: strategies are unit-testable and a
 * logged cycle can be replayed exactly. The runner owns all API calls, order
 * placement, rate limiting and logging.
 */
import type { V2TimeInForce } from '../tools/kalshi/orders-v2.js';

/** One market's top of book, in cents (1-99). NaN when the side is empty. */
export interface MarketQuote {
  ticker: string;
  status: string;
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  last: number;
  volume24h: number;
  closeTime: string;
  /** Settlement result once the market has settled ("yes" / "no"), else empty. */
  result?: string;
}

export interface RestingOrder {
  orderId: string;
  ticker: string;
  action: string;
  side: string;
  priceCents: number;
  remaining: number;
  clientOrderId?: string;
}

export interface Snapshot {
  now: Date;
  /** Keyed by ticker; a ticker missing here was not returned by the exchange. */
  markets: Record<string, MarketQuote>;
  /** Net contracts by ticker: positive = YES, negative = NO. Flat tickers are absent. */
  positions: Record<string, number>;
  restingOrders: RestingOrder[];
  cashCents: number;
}

export type Decision =
  | {
      kind: 'place';
      ticker: string;
      action: 'buy' | 'sell';
      side: 'yes' | 'no';
      count: number;
      /** Limit price in cents on `side` (1-99). */
      priceCents: number;
      timeInForce?: V2TimeInForce;
      reason: string;
    }
  | { kind: 'cancel'; orderId: string; ticker: string; reason: string }
  /** No action for this ticker this cycle — logged so a day's file explains itself. */
  | { kind: 'hold'; ticker: string; reason: string };

export interface Strategy<P = unknown> {
  name: string;
  summary: string;
  /** Parse and check a raw config object; throw with a clear message on bad input. */
  validate(raw: unknown): P;
  /** Tickers whose quotes the runner must fetch each cycle. */
  universe(params: P): string[];
  decide(snapshot: Snapshot, params: P): Decision[];
  /** Example config written by `strategy init`. */
  exampleConfig(): Record<string, unknown>;
}
