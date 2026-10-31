import { describe, it, expect } from 'bun:test';
import { threshold, type ThresholdParams } from '../examples/threshold.js';
import type { MarketQuote, Snapshot } from '../types.js';

const NOW = new Date('2026-10-31T12:00:00Z');

const params: ThresholdParams = threshold.validate({
  ...threshold.exampleConfig(),
  tickers: ['KX-A'],
});

function quote(over: Partial<MarketQuote> = {}): MarketQuote {
  return {
    ticker: 'KX-A', status: 'active', yesBid: 38, yesAsk: 40, noBid: 60, noAsk: 62,
    last: 39, volume24h: 1000, closeTime: '2026-11-30T00:00:00Z', ...over,
  };
}

function snap(over: Partial<Snapshot> = {}, q: Partial<MarketQuote> = {}): Snapshot {
  return { now: NOW, markets: { 'KX-A': quote(q) }, positions: {}, restingOrders: [], cashCents: 10_000, ...over };
}

describe('threshold.validate', () => {
  it('accepts the example config once tickers are set', () => {
    expect(params.tickers).toEqual(['KX-A']);
  });

  it('rejects inverted price bands', () => {
    expect(() => threshold.validate({ ...threshold.exampleConfig(), stopLossCents: 45 })).toThrow('stopLossCents < entryMaxCents');
  });

  it('rejects out-of-range cents', () => {
    expect(() => threshold.validate({ ...threshold.exampleConfig(), entryMaxCents: 140 })).toThrow('entryMaxCents');
  });
});

describe('threshold.decide', () => {
  it('buys at the ask when the ask is at or below entry', () => {
    const [d] = threshold.decide(snap(), params);
    expect(d).toMatchObject({ kind: 'place', action: 'buy', side: 'yes', count: 1, priceCents: 40, timeInForce: 'immediate_or_cancel' });
  });

  it('holds when the ask is above entry', () => {
    const [d] = threshold.decide(snap({}, { yesAsk: 41 }), params);
    expect(d).toMatchObject({ kind: 'hold', reason: expect.stringContaining('ask 41') });
  });

  it('takes profit on the whole position', () => {
    const [d] = threshold.decide(snap({ positions: { 'KX-A': 3 } }, { yesBid: 56, yesAsk: 58 }), params);
    expect(d).toMatchObject({ kind: 'place', action: 'sell', count: 3, priceCents: 56, reason: expect.stringContaining('take profit') });
  });

  it('stops out even when the market is closing soon', () => {
    const s = snap({ positions: { 'KX-A': 2 } }, { yesBid: 29, yesAsk: 31, closeTime: '2026-10-31T12:10:00Z' });
    const [d] = threshold.decide(s, params);
    expect(d).toMatchObject({ kind: 'place', action: 'sell', count: 2, reason: expect.stringContaining('stop loss') });
  });

  it('does not add past maxContracts', () => {
    const [d] = threshold.decide(snap({ positions: { 'KX-A': 3 } }), params);
    expect(d).toMatchObject({ kind: 'hold', reason: expect.stringContaining('max position') });
  });

  it('skips wide spreads, closing markets and inactive markets', () => {
    expect(threshold.decide(snap({}, { yesBid: 30 }), params)[0].kind).toBe('hold');
    expect(threshold.decide(snap({}, { closeTime: '2026-10-31T12:30:00Z' }), params)[0].kind).toBe('hold');
    expect(threshold.decide(snap({}, { status: 'closed' }), params)[0].kind).toBe('hold');
  });

  it('trades the NO side from NO quotes', () => {
    const p = { ...params, side: 'no' as const };
    const [d] = threshold.decide(snap({}, { noBid: 38, noAsk: 40 }), p);
    expect(d).toMatchObject({ kind: 'place', action: 'buy', side: 'no', priceCents: 40 });
  });

  it('leaves the opposite side and resting orders alone', () => {
    expect(threshold.decide(snap({ positions: { 'KX-A': -2 } }), params)[0].kind).toBe('hold');
    const resting = [{ orderId: 'o1', ticker: 'KX-A', action: 'buy', side: 'yes', priceCents: 40, remaining: 1 }];
    expect(threshold.decide(snap({ restingOrders: resting }), params)[0].kind).toBe('hold');
  });

  it('is deterministic', () => {
    const s = snap();
    expect(threshold.decide(s, params)).toEqual(threshold.decide(s, params));
  });
});
