/**
 * Paper book for `strategy run --paper`: simulated cash and positions,
 * filled against live Kalshi quotes, so a strategy can be judged on real
 * prices without sending an order.
 *
 * Fill model (deliberately simple, and optimistic about size):
 *   - buy fills at the current ask when the limit is at or above it
 *   - sell fills at the current bid when the limit is at or below it
 *   - the whole count fills at the top of book (no depth check)
 *   - every fill pays Kalshi's taker fee, ceil(0.07 · C · P · (1−P)) dollars
 *   - orders never rest: a limit that doesn't cross is simply not filled
 * Settled markets pay 100¢ per winning contract and 0¢ per losing one.
 */
import type { Decision, MarketQuote } from './types.js';

export interface PaperPosition {
  side: 'yes' | 'no';
  count: number;
  /** Total cost basis in cents, fees included. */
  costCents: number;
}

export interface PaperBook {
  startCashCents: number;
  cashCents: number;
  positions: Record<string, PaperPosition>;
  realizedCents: number;
  feesCents: number;
  fills: number;
}

export interface PaperFill {
  ticker: string;
  action: 'buy' | 'sell' | 'settle';
  side: 'yes' | 'no';
  count: number;
  priceCents: number;
  feeCents: number;
  /** Realized P&L in cents for sells and settlements. */
  realizedCents?: number;
}

export type PaperOutcome =
  | { filled: true; fill: PaperFill }
  | { filled: false; note: string };

export function newBook(startCashCents: number): PaperBook {
  return { startCashCents, cashCents: startCashCents, positions: {}, realizedCents: 0, feesCents: 0, fills: 0 };
}

/** Kalshi taker fee in cents for `count` contracts at `priceCents`. */
export function takerFeeCents(count: number, priceCents: number): number {
  const p = priceCents / 100;
  return Math.ceil(7 * count * p * (1 - p) - 1e-9);
}

/** Net contracts by ticker, signed like the exchange: +YES / −NO. */
export function bookPositions(book: PaperBook): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [t, p] of Object.entries(book.positions)) out[t] = p.side === 'yes' ? p.count : -p.count;
  return out;
}

export function simulate(book: PaperBook, d: Extract<Decision, { kind: 'place' }>, q: MarketQuote | undefined): PaperOutcome {
  if (!q) return { filled: false, note: 'no quote' };
  const held = book.positions[d.ticker];

  if (d.action === 'buy') {
    const ask = d.side === 'yes' ? q.yesAsk : q.noAsk;
    if (!Number.isFinite(ask)) return { filled: false, note: `no ${d.side} ask` };
    if (d.priceCents < ask) return { filled: false, note: `limit ${d.priceCents}¢ below ask ${ask}¢` };
    if (held && held.side !== d.side) return { filled: false, note: `paper book holds ${held.side.toUpperCase()} on this market` };
    const fee = takerFeeCents(d.count, ask);
    const cost = ask * d.count + fee;
    if (cost > book.cashCents) return { filled: false, note: `insufficient paper cash (${cost}¢ needed, ${book.cashCents}¢ available)` };
    book.cashCents -= cost;
    book.feesCents += fee;
    book.fills++;
    const pos = held ?? { side: d.side, count: 0, costCents: 0 };
    pos.count += d.count;
    pos.costCents += cost;
    book.positions[d.ticker] = pos;
    return { filled: true, fill: { ticker: d.ticker, action: 'buy', side: d.side, count: d.count, priceCents: ask, feeCents: fee } };
  }

  const bid = d.side === 'yes' ? q.yesBid : q.noBid;
  if (!held || held.side !== d.side || held.count <= 0) return { filled: false, note: `no paper ${d.side.toUpperCase()} position to sell` };
  if (!Number.isFinite(bid)) return { filled: false, note: `no ${d.side} bid` };
  if (d.priceCents > bid) return { filled: false, note: `limit ${d.priceCents}¢ above bid ${bid}¢` };
  const count = Math.min(d.count, held.count);
  const fee = takerFeeCents(count, bid);
  const basis = Math.round((held.costCents * count) / held.count);
  const realized = bid * count - fee - basis;
  book.cashCents += bid * count - fee;
  book.feesCents += fee;
  book.realizedCents += realized;
  book.fills++;
  held.count -= count;
  held.costCents -= basis;
  if (held.count <= 0) delete book.positions[d.ticker];
  return { filled: true, fill: { ticker: d.ticker, action: 'sell', side: d.side, count, priceCents: bid, feeCents: fee, realizedCents: realized } };
}

/** Pay out positions in markets that have settled. Returns the settlements made. */
export function settle(book: PaperBook, quotes: Record<string, MarketQuote>): PaperFill[] {
  const out: PaperFill[] = [];
  for (const [ticker, pos] of Object.entries(book.positions)) {
    const result = quotes[ticker]?.result;
    if (result !== 'yes' && result !== 'no') continue;
    const payPer = result === pos.side ? 100 : 0;
    const realized = payPer * pos.count - pos.costCents;
    book.cashCents += payPer * pos.count;
    book.realizedCents += realized;
    delete book.positions[ticker];
    out.push({ ticker, action: 'settle', side: pos.side, count: pos.count, priceCents: payPer, feeCents: 0, realizedCents: realized });
  }
  return out;
}

export interface PaperSummary {
  cashCents: number;
  /** Cash plus open positions marked at the current bid (cost basis when there is no bid). */
  equityCents: number;
  realizedCents: number;
  feesCents: number;
  returnPct: number;
  fills: number;
  openPositions: Record<string, { side: 'yes' | 'no'; count: number; costCents: number; markCents: number }>;
}

export function summarize(book: PaperBook, quotes: Record<string, MarketQuote>): PaperSummary {
  let marked = 0;
  const openPositions: PaperSummary['openPositions'] = {};
  for (const [ticker, pos] of Object.entries(book.positions)) {
    const q = quotes[ticker];
    const bid = q ? (pos.side === 'yes' ? q.yesBid : q.noBid) : NaN;
    const mark = Number.isFinite(bid) ? bid * pos.count : pos.costCents;
    marked += mark;
    openPositions[ticker] = { side: pos.side, count: pos.count, costCents: pos.costCents, markCents: mark };
  }
  const equityCents = book.cashCents + marked;
  return {
    cashCents: book.cashCents,
    equityCents,
    realizedCents: book.realizedCents,
    feesCents: book.feesCents,
    returnPct: book.startCashCents > 0 ? ((equityCents - book.startCashCents) / book.startCashCents) * 100 : 0,
    fills: book.fills,
    openPositions,
  };
}
