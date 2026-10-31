/**
 * Example strategy: a fixed price band per market.
 *
 * Template only — every number comes from the config, nothing here is a
 * view on what is profitable. For each ticker, on one side (yes or no):
 *   - enter: buy when the ask is at or below entryMaxCents, up to maxContracts
 *   - exit:  sell the whole position when the bid reaches takeProfitCents or
 *            falls to stopLossCents
 *   - skip:  inactive markets, markets closing within minMinutesToClose, and
 *            spreads wider than maxSpreadCents (exits still run)
 * Orders are immediate-or-cancel at the touch, so nothing is left resting.
 */
import type { Decision, Snapshot, Strategy } from '../types.js';

export interface ThresholdParams {
  tickers: string[];
  side: 'yes' | 'no';
  entryMaxCents: number;
  takeProfitCents: number;
  stopLossCents: number;
  contractsPerOrder: number;
  maxContracts: number;
  maxSpreadCents: number;
  minMinutesToClose: number;
}

function cents(raw: Record<string, unknown>, key: string): number {
  const v = raw[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 99) {
    throw new Error(`${key} must be a whole number of cents between 1 and 99 (got ${JSON.stringify(v)})`);
  }
  return v;
}

function positive(raw: Record<string, unknown>, key: string, integer = true): number {
  const v = raw[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (integer && !Number.isInteger(v))) {
    throw new Error(`${key} must be a ${integer ? 'whole ' : ''}number >= 0 (got ${JSON.stringify(v)})`);
  }
  return v;
}

export const threshold: Strategy<ThresholdParams> = {
  name: 'threshold',
  summary: 'Buy below a fixed price, sell at a take-profit or stop-loss price',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('config must be a JSON object');
    const raw = input as Record<string, unknown>;
    const tickers = raw.tickers;
    if (!Array.isArray(tickers) || tickers.length === 0 || !tickers.every((t) => typeof t === 'string' && t.length > 0)) {
      throw new Error('tickers must be a non-empty array of market tickers');
    }
    if (raw.side !== 'yes' && raw.side !== 'no') throw new Error('side must be "yes" or "no"');
    const p: ThresholdParams = {
      tickers: [...new Set(tickers as string[])],
      side: raw.side,
      entryMaxCents: cents(raw, 'entryMaxCents'),
      takeProfitCents: cents(raw, 'takeProfitCents'),
      stopLossCents: cents(raw, 'stopLossCents'),
      contractsPerOrder: positive(raw, 'contractsPerOrder'),
      maxContracts: positive(raw, 'maxContracts'),
      maxSpreadCents: positive(raw, 'maxSpreadCents'),
      minMinutesToClose: positive(raw, 'minMinutesToClose', false),
    };
    if (p.contractsPerOrder < 1) throw new Error('contractsPerOrder must be at least 1');
    if (!(p.stopLossCents < p.entryMaxCents && p.entryMaxCents < p.takeProfitCents)) {
      throw new Error('prices must satisfy stopLossCents < entryMaxCents < takeProfitCents');
    }
    return p;
  },

  universe: (p) => p.tickers,

  decide(s: Snapshot, p: ThresholdParams): Decision[] {
    const out: Decision[] = [];
    for (const ticker of p.tickers) {
      const q = s.markets[ticker];
      if (!q) {
        out.push({ kind: 'hold', ticker, reason: 'no quote returned for ticker' });
        continue;
      }
      const bid = p.side === 'yes' ? q.yesBid : q.noBid;
      const ask = p.side === 'yes' ? q.yesAsk : q.noAsk;
      const net = s.positions[ticker] ?? 0;
      const held = p.side === 'yes' ? Math.max(0, net) : Math.max(0, -net);

      if ((p.side === 'yes' && net < 0) || (p.side === 'no' && net > 0)) {
        out.push({ kind: 'hold', ticker, reason: `holding the opposite side (${net}); not trading it` });
        continue;
      }
      if (s.restingOrders.some((o) => o.ticker === ticker)) {
        out.push({ kind: 'hold', ticker, reason: 'an order is already resting on this market' });
        continue;
      }

      // Exits run even when entry filters would skip the market.
      if (held > 0 && Number.isFinite(bid)) {
        if (bid >= p.takeProfitCents) {
          out.push({ kind: 'place', ticker, action: 'sell', side: p.side, count: held, priceCents: bid,
            timeInForce: 'immediate_or_cancel', reason: `take profit: bid ${bid}¢ >= ${p.takeProfitCents}¢` });
          continue;
        }
        if (bid <= p.stopLossCents) {
          out.push({ kind: 'place', ticker, action: 'sell', side: p.side, count: held, priceCents: bid,
            timeInForce: 'immediate_or_cancel', reason: `stop loss: bid ${bid}¢ <= ${p.stopLossCents}¢` });
          continue;
        }
      }

      if (q.status !== 'active' && q.status !== 'open') {
        out.push({ kind: 'hold', ticker, reason: `market status is ${q.status}` });
        continue;
      }
      const minutesToClose = (Date.parse(q.closeTime) - s.now.getTime()) / 60_000;
      if (Number.isFinite(minutesToClose) && minutesToClose < p.minMinutesToClose) {
        out.push({ kind: 'hold', ticker, reason: `closes in ${Math.round(minutesToClose)} min < ${p.minMinutesToClose}` });
        continue;
      }
      if (!Number.isFinite(ask) || !Number.isFinite(bid)) {
        out.push({ kind: 'hold', ticker, reason: `no two-sided ${p.side} market` });
        continue;
      }
      if (ask - bid > p.maxSpreadCents) {
        out.push({ kind: 'hold', ticker, reason: `spread ${ask - bid}¢ > ${p.maxSpreadCents}¢` });
        continue;
      }
      const room = p.maxContracts - held;
      if (room <= 0) {
        out.push({ kind: 'hold', ticker, reason: `at max position (${held}/${p.maxContracts})` });
        continue;
      }
      if (ask > p.entryMaxCents) {
        out.push({ kind: 'hold', ticker, reason: `ask ${ask}¢ > entry ${p.entryMaxCents}¢` });
        continue;
      }
      out.push({ kind: 'place', ticker, action: 'buy', side: p.side, count: Math.min(p.contractsPerOrder, room),
        priceCents: ask, timeInForce: 'immediate_or_cancel', reason: `entry: ask ${ask}¢ <= ${p.entryMaxCents}¢` });
    }
    return out;
  },

  exampleConfig: () => ({
    strategy: 'threshold',
    tickers: ['REPLACE-WITH-A-MARKET-TICKER'],
    side: 'yes',
    entryMaxCents: 40,
    takeProfitCents: 55,
    stopLossCents: 30,
    contractsPerOrder: 1,
    maxContracts: 3,
    maxSpreadCents: 5,
    minMinutesToClose: 60,
    maxOrdersPerCycle: 5,
    paperCashCents: 10_000,
  }),
};
