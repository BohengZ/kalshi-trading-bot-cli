/**
 * `kalshi strategy` — run deterministic strategies (no LLM in the loop).
 *
 *   strategy list                          strategies + configs
 *   strategy init <name> [--strategy s]    write an example config to edit
 *   strategy run <name> [--interval m] [--once] [--dry-run | --live [--allow-prod]]
 *   strategy reset <name>                  start the paper book (and counters) over
 *
 * Paper by default: live Kalshi quotes, simulated fills and P&L, no orders
 * and no account reads. --dry-run only decides. --live sends orders; on
 * production it also needs --allow-prod.
 */
import type { ParsedArgs } from './parse-args.js';
import { STRATEGIES } from '../strategy/registry.js';
import {
  assertModeAllowed, configPath, defaultDeps, listConfigs, loadConfig, resetState, runCycle, writeExampleConfig,
  type CycleResult, type Mode,
} from '../strategy/runner.js';
import { localDate } from '../audit/trade-log.js';
import { appPath } from '../utils/paths.js';

const DEFAULT_INTERVAL_MIN = 1;
const MIN_INTERVAL_MIN = 0.5;
const MAX_CONSECUTIVE_FAILURES = 3;

export const STRATEGY_USAGE = [
  'Usage:',
  '  kalshi strategy list',
  '  kalshi strategy init <name> [--strategy threshold]',
  '  kalshi strategy run <name> [--interval <min>] [--once] [--dry-run | --live [--allow-prod]]',
  '  kalshi strategy reset <name>',
].join('\n');

export function formatStrategyList(): string {
  const dir = appPath('strategies');
  const lines = ['**Strategies**', ''];
  for (const s of Object.values(STRATEGIES)) lines.push(`  ${s.name.padEnd(14)} ${s.summary}`);
  lines.push('', `**Configs** (${dir})`, '');
  const configs = listConfigs(dir);
  if (configs.length === 0) lines.push('  none yet — kalshi strategy init <name>');
  for (const c of configs) {
    try {
      const cfg = loadConfig(dir, c);
      lines.push(`  ${c.padEnd(14)} ${cfg.strategy.name} on ${cfg.strategy.universe(cfg.params).length} market(s)`);
    } catch (err) {
      lines.push(`  ${c.padEnd(14)} ✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return lines.join('\n');
}

export function initStrategyConfig(name: string | undefined, strategyName = 'threshold'): string {
  if (!name) return STRATEGY_USAGE;
  const path = writeExampleConfig(appPath('strategies'), name, strategyName);
  return [
    `Wrote ${path}`,
    '',
    'Edit it: replace the tickers and set the prices and sizes you want. Then paper-trade one cycle',
    '(live quotes, simulated fills, no orders):',
    `  kalshi strategy run ${name} --once`,
  ].join('\n');
}

function dollars(cents: number): string {
  return `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function formatCycle(r: CycleResult, name: string): string {
  const head = `[${new Date().toLocaleTimeString()}] ${name} cycle #${r.cycle} · ${r.env} · ${r.mode} · ${r.apiCalls} API calls`;
  if (r.error) return `${head}\n  ✗ ${r.error}`;
  const lines = [head];
  for (const d of r.decisions) {
    if (d.kind === 'hold') {
      lines.push(`  · ${d.ticker}: hold — ${d.reason}`);
      continue;
    }
    const res = r.results.find((x) => x.decision === d);
    const what = d.kind === 'place'
      ? `${d.action.toUpperCase()} ${d.count} ${d.side.toUpperCase()} @ ${d.priceCents}¢`
      : `CANCEL ${d.orderId}`;
    const status = res ? `${res.status}${res.note ? ` (${res.note})` : ''}${res.orderId ? ` ${res.orderId}` : ''}` : '';
    lines.push(`  → ${d.ticker}: ${what} — ${d.reason} [${status}]`);
  }
  if (r.newFills > 0) lines.push(`  ✓ ${r.newFills} new ${r.mode === 'paper' ? 'paper ' : ''}fill(s)`);
  if (r.paper) {
    const p = r.paper;
    const open = Object.entries(p.openPositions).map(([t, o]) => `${t} ${o.count} ${o.side.toUpperCase()}`).join(', ') || 'none';
    lines.push(`  ≈ paper: equity ${dollars(p.equityCents)} (${p.returnPct >= 0 ? '+' : ''}${p.returnPct.toFixed(2)}%) · cash ${dollars(p.cashCents)} · realized ${dollars(p.realizedCents)} · fees ${dollars(p.feesCents)} · open: ${open}`);
  }
  return lines.join('\n');
}

/** CLI entry. Returns the process exit code. */
export async function handleStrategy(args: ParsedArgs): Promise<number> {
  const [sub, name] = args.positionalArgs;
  if (sub === 'list' || sub === undefined) {
    console.log(formatStrategyList());
    return 0;
  }
  if (sub === 'init') {
    try {
      console.log(initStrategyConfig(name, args.strategyName));
      return name ? 0 : 1;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }
  if (sub === 'reset' && name) {
    const removed = resetState(appPath('strategies'), name);
    console.log(removed ? `Reset ${name}: paper book, cycle counter and fills cursor cleared.` : `Nothing to reset for ${name}.`);
    return 0;
  }
  if (sub !== 'run' || !name) {
    console.error(STRATEGY_USAGE);
    return 1;
  }

  if (args.live && args.dryRun) {
    console.error('Pick one: --live sends orders, --dry-run only decides.');
    return 1;
  }
  const mode: Mode = args.live ? 'live' : args.dryRun ? 'dry-run' : 'paper';
  const deps = defaultDeps();
  let cfg;
  try {
    assertModeAllowed(mode, args.allowProd);
    cfg = loadConfig(deps.dir, name);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const intervalMin = Math.max(MIN_INTERVAL_MIN, args.interval ?? DEFAULT_INTERVAL_MIN);
  const env = process.env.KALSHI_USE_DEMO === 'true' ? 'DEMO' : 'PRODUCTION';
  const modeText = { live: 'LIVE: orders will be sent', paper: 'paper: live quotes, simulated fills, no orders sent', 'dry-run': 'dry run: decisions only, no orders sent' }[mode];
  console.log(`Strategy ${name} (${cfg.strategy.name}) on ${env} quotes — ${modeText}`);
  if (mode === 'paper') console.log(`Paper book starts at ${dollars(cfg.paperCashCents)} (paperCashCents); kalshi strategy reset ${name} to start over.`);
  console.log(`Config: ${configPath(deps.dir, name)}`);
  console.log(`Log:    ${appPath('trades', `${localDate(new Date())}.jsonl`)}`);
  if (!args.once) console.log(`Cycle every ${intervalMin}m — Ctrl-C to stop.`);
  console.log('');

  let stopped = false;
  process.once('SIGINT', () => { stopped = true; console.log('\nStopping after the current cycle...'); });
  process.once('SIGTERM', () => { stopped = true; });

  let failures = 0;
  for (;;) {
    const r = await runCycle(cfg, { mode }, deps);
    console.log(args.json ? JSON.stringify(r) : formatCycle(r, name));
    failures = r.error ? failures + 1 : 0;
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      console.error(`Stopping: ${failures} cycles in a row failed.`);
      return 1;
    }
    if (args.once || stopped) return r.error ? 1 : 0;
    const wakeAt = Date.now() + intervalMin * 60_000;
    while (Date.now() < wakeAt && !stopped) await new Promise((res) => setTimeout(res, 500));
    if (stopped) return 0;
  }
}
