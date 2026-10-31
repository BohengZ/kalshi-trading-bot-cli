/**
 * Client-side throttle for the Kalshi Trade API.
 *
 * Kalshi meters each account with continuously refilling token buckets: one
 * for reads (GET) and one for writes (orders, amends, cancels). A default
 * call costs 10 tokens and batch calls are billed per item. Going over
 * returns a bare 429 with no Retry-After, so we pace ourselves instead —
 * at SAFETY_FACTOR of the tier's budget, leaving headroom for other clients
 * on the same key. withRetry's 429 backoff stays as the fallback.
 *
 * Docs: https://docs.kalshi.com/getting_started/rate_limits
 */
import { getBotSetting } from '../../utils/bot-config.js';

/** Tokens per second, per Kalshi's published tier table. */
export const RATE_TIERS = {
  basic: { read: 200, write: 100 },
  advanced: { read: 300, write: 300 },
  expert: { read: 600, write: 600 },
  premier: { read: 1200, write: 1200 },
  paragon: { read: 2400, write: 2400 },
  prime: { read: 4800, write: 4800 },
  prestige: { read: 12000, write: 9600 },
} as const;

export type RateTier = keyof typeof RATE_TIERS;

const TOKENS_PER_CALL = 10;
const SAFETY_FACTOR = 0.5;

type Clock = () => number;
type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Continuously refilling bucket, measured in calls. Starts full. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly capacity: number = ratePerSec,
    private readonly now: Clock = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.ratePerSec);
    this.last = t;
  }

  /**
   * Milliseconds to wait before `cost` calls may go out. A cost larger than
   * the bucket waits for a full bucket and then runs it into debt, so the
   * calls after a big batch are held back until it is paid off.
   */
  waitMs(cost: number): number {
    this.refill();
    const need = Math.min(cost, this.capacity);
    if (this.tokens >= need) return 0;
    return Math.ceil(((need - this.tokens) / this.ratePerSec) * 1000);
  }

  async take(cost: number, sleep: Sleep = defaultSleep): Promise<void> {
    for (let wait = this.waitMs(cost); wait > 0; wait = this.waitMs(cost)) {
      await sleep(wait);
    }
    this.tokens -= cost;
  }
}

export function resolveTier(raw: unknown): RateTier {
  return typeof raw === 'string' && raw in RATE_TIERS ? (raw as RateTier) : 'basic';
}

let current: { tier: RateTier; read: TokenBucket; write: TokenBucket } | null = null;

function buckets() {
  const tier = resolveTier(getBotSetting('api.rate_tier'));
  if (!current || current.tier !== tier) {
    const budget = RATE_TIERS[tier];
    current = {
      tier,
      read: new TokenBucket((budget.read / TOKENS_PER_CALL) * SAFETY_FACTOR),
      write: new TokenBucket((budget.write / TOKENS_PER_CALL) * SAFETY_FACTOR),
    };
  }
  return current;
}

/** Wait for room in the right bucket. `items` is the batch size (1 for single calls). */
export async function throttle(method: string, items = 1): Promise<void> {
  // Unit tests mock fetch and often fake timers; real pacing would only stall them.
  if (process.env.KALSHI_RATE_LIMIT === 'off') return;
  const b = buckets();
  await (method === 'GET' ? b.read : b.write).take(Math.max(1, items));
}
