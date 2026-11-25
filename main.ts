// Tiny trend bot for "Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana".
//
// hello: the harness greets the bot once, then sends one batch of bars per
// hour; this bot answers each batch with its orders for that bar, and stays
// silent (no orders) while the batch is still warm-up. One bar at a time,
// per symbol: ride an uptrend, sit in cash in a downtrend, cut losers fast.
//
// Strategy, per symbol, from its hourly closes only:
//   - fast EMA (8 bars) vs slow EMA (24 bars) + 12-bar momentum decide the
//     target weight: 20% of equity when the trend is up, 0% when it is down.
//   - an overextended price (close > 10% above the slow EMA) halves the
//     target, so the bot does not chase a vertical bar.
//   - risk exits: sell everything when a held position falls 7% below its
//     cost, or 8% below its own peak value; after any exit the symbol is
//     cooled off for 12 bars so a choppy market cannot whipsaw it back in.
//   - targets are capped so total desired exposure stays under 90% of
//     equity; buys never exceed the cash on hand (a sell's proceeds never
//     fund a buy in the same reply).
// Everything is deterministic: no clock, no environment, no randomness.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const FAST_N = 12n;
const SLOW_N = 36n;
const MOM_BARS = 12;
const MOM_MIN_BPS = 100n; // need a real 12-bar rise, not a dead-cat bounce
const MIN_HISTORY = 37;
const TARGET_BPS = 2000n; // 20% of equity per trending symbol
const MAX_TOTAL_BPS = 10000n; // 100% of equity across all symbols when all trend up
const EXTEND_BPS = 1000n; // >10% above slow EMA counts as overextended
const STOP_BPS = 700n; // 7% below cost -> exit
const TRAIL_BPS = 800n; // 8% below peak value -> exit
const MIN_TRADE = 2_000_000n; // 2 USDC, above the 1 USDC minimum notional
const SLIPPAGE_BPS = 200;

interface SymState {
  closes: bigint[];
  fast: bigint | null;
  slow: bigint | null;
  peak: bigint; // peak held value in quote units
  coolUntil: number; // seq before which the symbol may not be re-entered
}

const per: Map<string, SymState> = new Map();

function ema(prev: bigint | null, price: bigint, n: bigint): bigint {
  if (prev === null) return price;
  return (price * 2n + prev * (n - 1n)) / (n + 1n);
}

function qtyForValue(state: BarsState, symbol: string, quoteUnits: bigint): bigint {
  const sym = state.symbols.get(symbol);
  const price = state.close(symbol);
  if (sym === undefined || price === null || price === 0n) return 0n;
  const scale = 10n ** BigInt(sym.qty_scale + sym.price_scale);
  const quote = 10n ** BigInt(state.hello.capital.quote_scale);
  return (quoteUnits * scale) / (price * quote);
}

function targetBps(s: SymState, close: bigint, seq: number): bigint {
  if (seq < s.coolUntil) return 0n;
  if (s.fast === null || s.slow === null || s.closes.length < MIN_HISTORY) return 0n;
  if (s.fast <= s.slow) return 0n;
  const old = s.closes[s.closes.length - 1 - MOM_BARS];
  if (old === undefined || old === 0n) return 0n;
  const momBps = ((close - old) * 10_000n) / old;
  if (momBps <= MOM_MIN_BPS) return 0n;
  const overBps = ((close - s.slow) * 10_000n) / s.slow;
  return overBps > EXTEND_BPS ? TARGET_BPS / 2n : TARGET_BPS;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Fold this batch's bars into per-symbol history first.
    for (const bar of batch.bars) {
      let s = per.get(bar.symbol);
      if (s === undefined) {
        s = { closes: [], fast: null, slow: null, peak: 0n, coolUntil: -1 };
        per.set(bar.symbol, s);
      }
      const close = BigInt(bar.c);
      s.closes.push(close);
      s.fast = ema(s.fast, close, FAST_N);
      s.slow = ema(s.slow, close, SLOW_N);
    }
    if (state.warmingUp) return [];

    const orders: OrderInput[] = [];
    const symbols = [...state.symbols.keys()];

    // Desired weight per symbol, then scale down if the total is too big.
    const targets = new Map<string, bigint>();
    let total = 0n;
    for (const symbol of symbols) {
      const s = per.get(symbol);
      const close = state.close(symbol);
      if (s === undefined || close === null) continue;
      // Risk exits override the trend target for a held position.
      const pos = state.positions.get(symbol);
      if (pos !== undefined && pos.qty > 0n) {
        const value = state.value(symbol, pos.qty);
        if (value > s.peak) s.peak = value;
        const belowCost = value < (pos.cost * (10_000n - STOP_BPS)) / 10_000n;
        const belowPeak = value < (s.peak * (10_000n - TRAIL_BPS)) / 10_000n;
        if (belowCost || belowPeak) {
          targets.set(symbol, 0n);
          s.coolUntil = state.seq + 12; // no re-entry for 12 bars after a stop
          continue;
        }
      } else {
        s.peak = 0n;
      }
      const t = targetBps(s, close, state.seq);
      if (t === 0n && pos !== undefined && pos.qty > 0n) {
        s.coolUntil = state.seq + 12; // trend flipped while holding: cool off too
      }
      targets.set(symbol, t);
      total += t;
    }
    const scale = total > MAX_TOTAL_BPS ? (MAX_TOTAL_BPS * 10_000n) / total : 10_000n;

    // Sells first (their proceeds do not fund buys in this same reply).
    for (const symbol of symbols) {
      const t = targets.get(symbol);
      if (t === undefined) continue;
      const pos = state.positions.get(symbol);
      if (pos === undefined || pos.qty === 0n) continue;
      const desired = (t * scale * state.equity) / 100_000_000n;
      const current = state.value(symbol, pos.qty);
      if (current - desired <= MIN_TRADE) continue;
      const qty = qtyForValue(state, symbol, current - desired);
      const sellQty = qty > pos.qty ? pos.qty : qty;
      if (sellQty > 0n) {
        orders.push({ side: 'sell', symbol, qty: sellQty, max_slippage_bps: SLIPPAGE_BPS });
      }
    }

    // Buys sized to the cash actually on hand.
    let cash = state.cash;
    for (const symbol of symbols) {
      const t = targets.get(symbol);
      if (t === undefined) continue;
      const desired = (t * scale * state.equity) / 100_000_000n;
      const pos = state.positions.get(symbol);
      const current = pos === undefined ? 0n : state.value(symbol, pos.qty);
      if (desired - current <= MIN_TRADE) continue;
      let spend = desired - current;
      const room = state.weightRoom(symbol);
      if (spend > room) spend = room;
      if (spend > (cash * 95n) / 100n) spend = (cash * 95n) / 100n;
      if (spend <= MIN_TRADE) continue;
      orders.push({ side: 'buy', symbol, notional_quote_units: spend, max_slippage_bps: SLIPPAGE_BPS });
      cash -= spend;
    }
    return orders;
  },
});
