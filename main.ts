// Trend-following bot for "Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana".
//
// Protocol in one breath: the harness opens with a hello, then sends one
// batch per hour; each batch carries that hour's bar for every symbol plus
// the fills of the orders decided on the previous bar. The bot answers each
// batch with the orders it wants filled at the next bar's open, and answers
// warm-up batches with no orders at all.
//
// How it tries to beat buy-and-hold: never hold a symbol whose trend is not
// demonstrably up, and re-prove that trend on every bar. Buy-and-hold eats
// every dip of every asset for the whole window; this bot sits in USDC
// through downtrends and only rents exposure while momentum lasts, which
// caps the damage in a falling market and keeps most of the upside in a
// rising one. Position size follows trend strength, trimmed for jumpy
// symbols and for prices that have run too far ahead of their own trend.
//
// Per symbol, from hourly closes only:
//   - trend spread: EMA(12) vs EMA(36), in bps of the slow EMA; momentum:
//     close vs the close 12 bars ago, in bps.
//   - entry gate (checked for new positions): spread above +30 bps AND
//     momentum at least +100 bps. A held position must keep passing a
//     near-identical gate every bar (spread positive, momentum above
//     +100 bps); the bar it fails, the position is closed and the symbol
//     cools off for 8 bars. This tight leash is deliberate: looser exits
//     were backtested on the dev window and bled in its choppy downtrend.
//   - target weight by strength score (spread + momentum/2): tiers of
//     2200 / 1500 / 900 bps of equity, scaled to 2/3 or 1/2 when the
//     symbol's mean hourly move over 14 bars exceeds 200 / 450 bps, and
//     halved when the close runs more than 8% above the slow EMA (never
//     opened at all beyond 15%: that is chasing a vertical bar).
//   - price stops override the trend: exit at 6% under the average cost
//     price, or 9% under the highest close since entry; a stop locks the
//     symbol out for 10 bars.
//   - summed targets are capped at 85% of equity, rebalances inside a band
//     (the larger of 2 USDC or an eighth of the target) are skipped, sells
//     go first and never fund same-reply buys, and buys are filled
//     strongest-target-first out of the cash actually on hand.
// Fully deterministic: integer math only, no clock, no environment, no
// randomness, so the two grading runs produce identical orders.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

// ---- tunables (bps are 1/100 of a percent; bars are hours) ----
const FAST_N = 12n; // fast EMA length
const SLOW_N = 36n; // slow EMA length
const MOM_BARS = 12; // momentum lookback
const VOL_BARS = 14; // volatility lookback
const MIN_HISTORY = 37; // closes needed before a symbol can be traded
const KEEP = 48; // closes retained per symbol (covers every lookback)

const ENTER_SPREAD_BPS = 30n; // new entries need the fast EMA this far ahead
const ENTER_MOM_BPS = 100n; // ...and at least this much 12-bar momentum
const HOLD_MOM_BPS = 100n; // a held position is closed at or under this

const TIER1_SCORE = 250n; // strength-score thresholds for the weight tiers
const TIER2_SCORE = 120n;
const TIER3_SCORE = 50n;
const TIER1_BPS = 2200n; // target weight per tier, bps of equity
const TIER2_BPS = 1500n;
const TIER3_BPS = 900n;

const EXTEND_HALVE_BPS = 800n; // close this far over the slow EMA: half size
const EXTEND_BLOCK_BPS = 1500n; // this far over: no position at all
const VOL_CALM_BPS = 200n; // mean hourly move at or under this: full weight
const VOL_WILD_BPS = 450n; // between: 2/3 weight; above: 1/2 weight

const HARD_STOP_BPS = 600n; // exit at 6% under average cost price
const TRAIL_STOP_BPS = 900n; // exit at 9% under the best close since entry
const STOP_COOL_BARS = 10; // lockout after a stop exit
const TREND_COOL_BARS = 8; // lockout after a trend-gate exit

const MAX_TOTAL_BPS = 8500n; // cap on summed target weights
const BAND_MIN = 2_000_000n; // 2 USDC: smallest rebalance worth its fee
const SLIPPAGE_BPS = 300; // bound the next-open move we accept on a fill

interface Track {
  closes: bigint[]; // last KEEP closes, oldest first
  fast: bigint | null; // EMA(FAST_N) of the closes
  slow: bigint | null; // EMA(SLOW_N) of the closes
  peakClose: bigint; // highest close seen while holding (0n while flat)
  coolUntil: number; // first seq at which the symbol may be re-entered
}

const tracks = new Map<string, Track>();

function trackOf(symbol: string): Track {
  let t = tracks.get(symbol);
  if (t === undefined) {
    t = { closes: [], fast: null, slow: null, peakClose: 0n, coolUntil: -1 };
    tracks.set(symbol, t);
  }
  return t;
}

function emaStep(prev: bigint | null, price: bigint, n: bigint): bigint {
  if (prev === null) return price;
  return (price * 2n + prev * (n - 1n)) / (n + 1n);
}

/** Signed change from `from` to `to` in bps; 0 when `from` is unusable. */
function changeBps(from: bigint, to: bigint): bigint {
  if (from <= 0n) return 0n;
  return ((to - from) * 10_000n) / from;
}

/** Mean absolute bar-to-bar move over the last VOL_BARS closes, in bps. */
function meanMoveBps(closes: bigint[]): bigint {
  const n = Math.min(VOL_BARS, closes.length - 1);
  if (n <= 0) return 0n;
  let sum = 0n;
  for (let i = closes.length - n; i < closes.length; i++) {
    const step = changeBps(closes[i - 1]!, closes[i]!);
    sum += step < 0n ? -step : step;
  }
  return sum / BigInt(n);
}

/** Average cost price of a held position, from its cost basis and quantity. */
function avgCostPrice(state: BarsState, symbol: string): bigint | null {
  const pos = state.positions.get(symbol);
  const meta = state.symbols.get(symbol);
  if (pos === undefined || meta === undefined || pos.qty <= 0n) return null;
  const scales = 10n ** BigInt(meta.qty_scale + meta.price_scale);
  const quote = 10n ** BigInt(state.hello.capital.quote_scale);
  return (pos.cost * scales) / (pos.qty * quote);
}

/** Quantity of `symbol` worth `quoteUnits` at its latest close. */
function qtyWorth(state: BarsState, symbol: string, quoteUnits: bigint): bigint {
  const meta = state.symbols.get(symbol);
  const price = state.close(symbol);
  if (meta === undefined || price === null || price <= 0n) return 0n;
  const scales = 10n ** BigInt(meta.qty_scale + meta.price_scale);
  const quote = 10n ** BigInt(state.hello.capital.quote_scale);
  return (quoteUnits * scales) / (price * quote);
}

/**
 * Desired weight for one symbol in bps of equity, before the portfolio cap.
 * Side effect: a stop exit or a trend-gate exit starts the symbol's
 * cooldown on its track, and the returned 0 applies from this bar on.
 */
function desiredBps(state: BarsState, t: Track, symbol: string, close: bigint): bigint {
  const held = (state.positions.get(symbol)?.qty ?? 0n) > 0n;
  if (!held) t.peakClose = 0n;
  if (t.closes.length < MIN_HISTORY || t.fast === null || t.slow === null || t.slow <= 0n) return 0n;

  // Price stops first: they override any trend reading.
  if (held) {
    if (close > t.peakClose) t.peakClose = close;
    const entry = avgCostPrice(state, symbol);
    const stoppedOut =
      (entry !== null && changeBps(entry, close) <= -HARD_STOP_BPS) ||
      (t.peakClose > 0n && changeBps(t.peakClose, close) <= -TRAIL_STOP_BPS);
    if (stoppedOut) {
      t.coolUntil = state.seq + STOP_COOL_BARS;
      return 0n;
    }
  }
  if (state.seq < t.coolUntil) return 0n;

  const spread = changeBps(t.slow, t.fast);
  const ref = t.closes[t.closes.length - 1 - MOM_BARS];
  const mom = ref === undefined ? 0n : changeBps(ref, close);

  if (held) {
    // The leash: a position must keep proving its trend on every bar.
    if (spread <= 0n || mom <= HOLD_MOM_BPS) {
      t.coolUntil = state.seq + TREND_COOL_BARS;
      return 0n;
    }
  } else if (spread <= ENTER_SPREAD_BPS || mom < ENTER_MOM_BPS) {
    return 0n;
  }

  const score = spread + mom / 2n;
  let weight = score >= TIER1_SCORE ? TIER1_BPS : score >= TIER2_SCORE ? TIER2_BPS : score >= TIER3_SCORE ? TIER3_BPS : 0n;
  if (weight === 0n) return 0n;

  // Do not chase a price that has sprinted away from its own trend line.
  const extension = changeBps(t.slow, close);
  if (extension > EXTEND_BLOCK_BPS) return 0n;
  if (extension > EXTEND_HALVE_BPS) weight = weight / 2n;

  // Jumpy symbols get less room: the replay caps drawdown at 25%.
  const vol = meanMoveBps(t.closes);
  if (vol > VOL_WILD_BPS) weight = weight / 2n;
  else if (vol > VOL_CALM_BPS) weight = (weight * 2n) / 3n;
  return weight;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // History first: fold this batch's bar for each symbol into its track.
    for (const bar of batch.bars) {
      const t = trackOf(bar.symbol);
      const close = BigInt(bar.c);
      t.closes.push(close);
      if (t.closes.length > KEEP) t.closes.shift();
      t.fast = emaStep(t.fast, close, FAST_N);
      t.slow = emaStep(t.slow, close, SLOW_N);
    }
    if (state.warmingUp) return [];

    const symbols = [...state.symbols.keys()];

    // One target weight per symbol, then one shared scale-down if the book
    // as a whole would run past the exposure cap.
    const targets = new Map<string, bigint>();
    let summed = 0n;
    for (const symbol of symbols) {
      const close = state.close(symbol);
      if (close === null) continue;
      const w = desiredBps(state, trackOf(symbol), symbol, close);
      targets.set(symbol, w);
      summed += w;
    }
    const scaleNum = summed > MAX_TOTAL_BPS ? MAX_TOTAL_BPS : summed;
    const scaleDen = summed > 0n ? summed : 1n;
    const desiredValue = (symbol: string): bigint => {
      const w = targets.get(symbol) ?? 0n;
      return (w * scaleNum * state.equity) / (scaleDen * 10_000n);
    };
    const outsideBand = (symbol: string): bigint => {
      // Signed gap between target and current value; 0 inside the band.
      const pos = state.positions.get(symbol);
      const current = pos === undefined ? 0n : state.value(symbol, pos.qty);
      const target = desiredValue(symbol);
      const gap = target - current;
      const band = target / 8n > BAND_MIN ? target / 8n : BAND_MIN;
      return gap > band || gap < -band ? gap : 0n;
    };

    const orders: OrderInput[] = [];

    // Sells first: a sell's proceeds never fund a buy in the same reply.
    for (const symbol of symbols) {
      if (!targets.has(symbol)) continue;
      const gap = outsideBand(symbol);
      if (gap >= 0n) continue;
      const pos = state.positions.get(symbol);
      if (pos === undefined || pos.qty === 0n) continue;
      const qty = qtyWorth(state, symbol, -gap);
      const sellQty = qty > pos.qty ? pos.qty : qty;
      if (sellQty > 0n) orders.push({ side: 'sell', symbol, qty: sellQty, max_slippage_bps: SLIPPAGE_BPS });
    }

    // Buys, strongest target first, so the cash on hand goes to the best
    // trends when there is not enough for all of them.
    let cash = state.cash;
    const buyable = symbols
      .filter((s) => targets.has(s) && outsideBand(s) > 0n)
      .sort((a, b) => Number((targets.get(b) ?? 0n) - (targets.get(a) ?? 0n)) || (a < b ? -1 : 1));
    for (const symbol of buyable) {
      let spend = outsideBand(symbol);
      const room = state.weightRoom(symbol);
      if (spend > room) spend = room;
      if (spend > (cash * 98n) / 100n) spend = (cash * 98n) / 100n;
      if (spend < BAND_MIN) continue;
      orders.push({ side: 'buy', symbol, notional_quote_units: spend, max_slippage_bps: SLIPPAGE_BPS });
      cash -= spend;
    }
    return orders;
  },
});
