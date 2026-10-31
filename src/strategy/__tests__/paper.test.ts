import { describe, it, expect } from 'bun:test';
import { bookPositions, newBook, settle, simulate, summarize, takerFeeCents } from '../paper.js';
import type { Decision, MarketQuote } from '../types.js';

type Place = Extract<Decision, { kind: 'place' }>;

function q(over: Partial<MarketQuote> = {}): MarketQuote {
  return { ticker: 'KX-A', status: 'active', yesBid: 38, yesAsk: 40, noBid: 60, noAsk: 62, last: 39, volume24h: 0, closeTime: '', ...over };
}

function order(over: Partial<Place> = {}): Place {
  return { kind: 'place', ticker: 'KX-A', action: 'buy', side: 'yes', count: 2, priceCents: 40, reason: 'test', ...over };
}

describe('takerFeeCents', () => {
  it('matches Kalshi’s ceil(0.07 · C · P · (1−P)) rounded up to the cent', () => {
    expect(takerFeeCents(1, 50)).toBe(2);   // 1.75¢ → 2¢
    expect(takerFeeCents(100, 50)).toBe(175);
    expect(takerFeeCents(10, 91)).toBe(6);  // 5.733¢ → 6¢
  });
});

describe('simulate', () => {
  it('fills a buy at the ask, charges the fee and debits cash', () => {
    const book = newBook(10_000);
    const r = simulate(book, order(), q());
    expect(r).toMatchObject({ filled: true, fill: { priceCents: 40, count: 2, feeCents: 4 } });
    expect(book.cashCents).toBe(10_000 - 80 - 4);
    expect(bookPositions(book)).toEqual({ 'KX-A': 2 });
  });

  it('fills at the better ask, not the limit', () => {
    const book = newBook(10_000);
    const r = simulate(book, order({ priceCents: 45 }), q());
    expect(r).toMatchObject({ filled: true, fill: { priceCents: 40 } });
  });

  it('does not fill a limit that does not cross', () => {
    const r = simulate(newBook(10_000), order({ priceCents: 39 }), q());
    expect(r).toMatchObject({ filled: false, note: expect.stringContaining('below ask') });
  });

  it('refuses a buy the paper cash cannot cover', () => {
    const r = simulate(newBook(50), order(), q());
    expect(r).toMatchObject({ filled: false, note: expect.stringContaining('insufficient paper cash') });
  });

  it('sells at the bid and realizes P&L against the cost basis', () => {
    const book = newBook(10_000);
    simulate(book, order(), q());                                   // cost 80 + 4 fee
    const r = simulate(book, order({ action: 'sell', priceCents: 55 }), q({ yesBid: 55 }));
    expect(r).toMatchObject({ filled: true, fill: { priceCents: 55, feeCents: 4, realizedCents: 110 - 4 - 84 } });
    expect(book.positions).toEqual({});
    expect(book.cashCents).toBe(10_000 - 84 + 106);
  });

  it('trades NO from NO quotes and records it as a negative position', () => {
    const book = newBook(10_000);
    simulate(book, order({ side: 'no', priceCents: 62 }), q());
    expect(bookPositions(book)).toEqual({ 'KX-A': -2 });
  });

  it('cannot sell what the book does not hold', () => {
    const r = simulate(newBook(10_000), order({ action: 'sell' }), q());
    expect(r).toMatchObject({ filled: false, note: expect.stringContaining('no paper YES position') });
  });
});

describe('settle and summarize', () => {
  it('pays winners 100¢ and losers 0¢ on settled markets', () => {
    const book = newBook(10_000);
    simulate(book, order(), q());
    simulate(book, order({ ticker: 'KX-B', side: 'no', priceCents: 62 }), q({ ticker: 'KX-B' }));

    const fills = settle(book, { 'KX-A': q({ result: 'yes' }), 'KX-B': q({ ticker: 'KX-B', result: 'yes' }) });

    expect(fills.map((f) => [f.ticker, f.priceCents])).toEqual([['KX-A', 100], ['KX-B', 0]]);
    expect(book.positions).toEqual({});
    expect(book.realizedCents).toBe((200 - 84) + (0 - 128));
  });

  it('leaves unsettled markets open', () => {
    const book = newBook(10_000);
    simulate(book, order(), q());
    expect(settle(book, { 'KX-A': q() })).toEqual([]);
    expect(Object.keys(book.positions)).toEqual(['KX-A']);
  });

  it('marks open positions at the bid for equity and return', () => {
    const book = newBook(10_000);
    simulate(book, order(), q());
    const s = summarize(book, { 'KX-A': q({ yesBid: 50 }) });
    expect(s.equityCents).toBe(10_000 - 84 + 100);
    expect(s.returnPct).toBeCloseTo(0.16);
    expect(s.openPositions['KX-A']).toMatchObject({ count: 2, markCents: 100 });
  });
});
