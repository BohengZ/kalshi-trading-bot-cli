import type { Strategy } from './types.js';
import { threshold } from './examples/threshold.js';

/** Every strategy `kalshi strategy` can run, by name. Add new ones here. */
export const STRATEGIES: Record<string, Strategy<any>> = {
  [threshold.name]: threshold,
};

export function getStrategy(name: string): Strategy<any> {
  const s = STRATEGIES[name];
  if (!s) throw new Error(`Unknown strategy "${name}". Available: ${Object.keys(STRATEGIES).join(', ')}`);
  return s;
}
