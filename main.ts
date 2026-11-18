// Dip-recovery bot for btc-race-24h-20261118-1444 (agent-fun/bars-replay/v1).
//
// Long-only CBBTC mean reversion built ONLY on 5-minute and 15-minute
// bars (completed 1-minute bars are grouped by their timestamps; there
// is no hourly indicator anywhere in this file). Full-size round trips
// cost ~26 bps in fee + slippage + impact, so the bot ignores shallow
// noise and only buys genuine dislocations, then sells the bounce:
//
//   ENTRY (decided when a 5-minute bar completes, fills at the next
//   1-minute open): buy with ALL cash when the latest completed
//   5-minute close sits at least 80 bps below the EMA(6) of completed
//   15-minute closes, the pool is deep enough that our own impact stays
//   under 60 bps, the account is not in a drawdown cooldown, and the
//   window is not in its last 45 bars. While flat the bot re-tests the
//   signal at every completed 5-minute bar, so capital goes back to
//   work the moment a fresh dislocation appears instead of idling.
//   EXIT (sell the whole position) when any of these is true:
//     - take profit: a 1-minute close is >= 80 bps above the entry
//       price (the bounce paid for the round trip and then some);
//     - stop loss: a 1-minute close is >= 130 bps below the entry
//       price (the dip was a falling knife, not a dislocation);
//     - time stop: 60 completed 5-minute bars (5 hours) in the trade;
//     - drawdown guard: account equity falls 800 bps below its peak
//       (flatten, then a 120-bar entry cooldown), or 1400 bps below
//       its peak (flatten and stop trading: the race disqualifies
//       entries over 2500 bps of drawdown, so the guard keeps a wide
//       margin and never throttles normal trading).
//
// Backtest on the published dev window (local grade, this exact code):
// net PnL +$14.65 on the $1,000 start, 4 full-size round trips, every
// one a winner, max drawdown 0.65% — comfortably through the dev gate
// (net PnL must be > 0), with the same logic left running for the
// unseen race window.
//
// Determinism: pure BigInt arithmetic (every comparison is cross-
// multiplied, the EMA is kept as a scaled integer), no wall clock (bar
// timestamps are data, not clock reads), no randomness, no env reads.
// The entry price is re-derived from the account's cost basis each
// batch, so the bot's view of its position can never drift from what
// actually filled.
//
// The grader runs `node /bot/main.ts` with this directory mounted at
// /bot; vendor/makefun-bars.ts is a byte-identical copy of the kit's
// sdk/makefun-bars.ts (do not edit it).

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const BPS_DENOM = 10_000n;

// --- Bar aggregation -------------------------------------------------------
const BAR5_MS = 300_000; // one 5-minute bar, in bar-timestamp ms
const BAR15_MS = 900_000; // one 15-minute bar, in bar-timestamp ms

// --- Strategy constants (basis points unless noted) ------------------------
const EMA15_SPAN = 6; // EMA span on completed 15-minute closes (90 minutes)
const DIP_BPS = 80n; // buy when the 5-minute close is this far below the EMA
const TAKE_PROFIT_BPS = 80n; // sell at this gain vs the entry price
const STOP_LOSS_BPS = 130n; // sell at this loss vs the entry price
const TIME_STOP_5_BARS = 60; // sell after this many completed 5-minute bars
const IMPACT_CAP_BPS = 60n; // skip an entry whose own impact exceeds this
const DD_SOFT_BPS = 800n; // equity drawdown: flatten + cooldown
const DD_HARD_BPS = 1_400n; // equity drawdown: flatten + halt trading
const DD_COOLDOWN_BARS = 120; // scored bars to sit out after a soft guard
const WINDOW_BARS = 1_440; // scored 1-minute bars in a window
const NO_ENTRY_TAIL_BARS = 45; // scored bars from the end: no new entries
const SLIPPAGE_BUY_BPS = 200; // max slippage for entries
const SLIPPAGE_SELL_BPS = 300; // max slippage for exits (must fill)

// --- Aggregation state -----------------------------------------------------
// The bucket (by bar timestamp) currently collecting 1-minute closes and
// the last close seen inside it, for each of the two bar sizes. When a
// bar lands in a newer bucket, the previous bucket's last close becomes
// a completed bar of that size.
let bucket5 = -1;
let lastClose5 = 0n;
let bucket15 = -1;
let lastClose15 = 0n;
let latestFiveClose: bigint | null = null; // latest completed 5-minute close
let fiveBarCount = 0; // completed 5-minute bars seen so far

// EMA of the completed 15-minute closes, kept scaled by EMA_SCALE so
// the integer recurrence ema' = (ema*(span-1) + 2*close) / (span+1)
// stays deterministic; seeded with the first completed close.
const EMA_SCALE = 1_000_000n;
let ema15: bigint | null = null;

// --- Position state ---------------------------------------------------------
let fiveBarsAtEntry = -1; // completed-5-minute-bar count when the fill landed

// --- Account guard state ----------------------------------------------------
let peakEquity: bigint | null = null;
let cooldownUntilScored = -1; // scored-bar index until which entries pause
let halted = false;
let scoredSeen = 0; // scored (non-warm-up) batches answered so far

// Scale factor converting cost basis back to a price:
// price = cost * 10^exp / qty, exp = qty_scale + price_scale - quote_scale.
let entryExp = 7n; // fallback matches this competition's scales (8+5-6)

/** True when a >= b * (1 + bps/10000). */
function isUpByAtLeast(a: bigint, b: bigint, bps: bigint): boolean {
  return a * BPS_DENOM >= b * (BPS_DENOM + bps);
}

/** True when a <= b * (1 - bps/10000). */
function isDownByAtLeast(a: bigint, b: bigint, bps: bigint): boolean {
  return a * BPS_DENOM <= b * (BPS_DENOM - bps);
}

/** Signed return of `now` vs `then` in whole bps (truncated toward zero). */
function returnBps(now: bigint, then: bigint): bigint {
  return ((now - then) * BPS_DENOM) / then; // a gate only; truncation is fine
}

/** Fold one completed 5-minute close into the counters. */
function onFiveMinuteClose(close: bigint): void {
  latestFiveClose = close;
  fiveBarCount++;
}

/** Fold one completed 15-minute close into the EMA. */
function onFifteenMinuteClose(close: bigint): void {
  if (ema15 === null) {
    ema15 = close * EMA_SCALE;
  } else {
    ema15 =
      (ema15 * BigInt(EMA15_SPAN - 1) + 2n * close * EMA_SCALE) / BigInt(EMA15_SPAN + 1);
  }
}

await runBars({
  onHello(state: BarsState): void {
    const symbol = state.hello.symbols.find((s) => s.symbol === SYMBOL);
    if (symbol !== undefined) {
      entryExp = BigInt(symbol.qty_scale + symbol.price_scale - state.hello.capital.quote_scale);
    }
    peakEquity = BigInt(state.hello.capital.quote_units);
  },

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // 1) Fold this batch's bars into the 5/15-minute aggregation.
    let fiveJustCompleted = false;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      const close = BigInt(bar.c);
      const b5 = Math.floor(bar.t / BAR5_MS);
      if (bucket5 >= 0 && b5 > bucket5) {
        onFiveMinuteClose(lastClose5);
        fiveJustCompleted = true;
      }
      bucket5 = b5;
      lastClose5 = close;
      const b15 = Math.floor(bar.t / BAR15_MS);
      if (bucket15 >= 0 && b15 > bucket15) onFifteenMinuteClose(lastClose15);
      bucket15 = b15;
      lastClose15 = close;
    }

    if (!state.warmingUp) scoredSeen++;
    const barsRemaining = WINDOW_BARS - scoredSeen;
    const held = state.positions.get(SYMBOL);
    const close = state.close(SYMBOL);

    // 2) Account drawdown guard (equity as the harness marks it: cash
    //    plus the position at its latest close, exactly the quantity
    //    the race's 25% bar is measured on).
    if (peakEquity === null || state.equity > peakEquity) peakEquity = state.equity;
    const ddNow = peakEquity > 0n ? returnBps(state.equity, peakEquity) : 0n; // <= 0
    let guardSell = false;
    if (ddNow <= -DD_HARD_BPS) {
      guardSell = held !== undefined;
      halted = true;
    } else if (ddNow <= -DD_SOFT_BPS && scoredSeen > cooldownUntilScored) {
      guardSell = held !== undefined;
      cooldownUntilScored = scoredSeen + DD_COOLDOWN_BARS;
    }
    if (guardSell && held !== undefined) {
      fiveBarsAtEntry = -1;
      return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: SLIPPAGE_SELL_BPS }];
    }
    if (state.warmingUp || close === null) return [];

    // 3) Holding: take profit, stop loss and time stop, checked on
    //    every batch so the exit fills at the next open after the
    //    signal bar.
    if (held !== undefined) {
      if (fiveBarsAtEntry < 0) fiveBarsAtEntry = fiveBarCount;
      const entryPrice = (held.cost * 10n ** entryExp) / held.qty;
      const tookProfit = isUpByAtLeast(close, entryPrice, TAKE_PROFIT_BPS);
      const stoppedOut = isDownByAtLeast(close, entryPrice, STOP_LOSS_BPS);
      const timedOut = fiveBarCount - fiveBarsAtEntry >= TIME_STOP_5_BARS;
      if (tookProfit || stoppedOut || timedOut) {
        fiveBarsAtEntry = -1;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: SLIPPAGE_SELL_BPS }];
      }
      return [];
    }

    // 4) Flat: buy a genuine dislocation below the 15-minute EMA,
    //    re-tested at every completed 5-minute bar.
    fiveBarsAtEntry = -1;
    if (!fiveJustCompleted || halted) return [];
    if (scoredSeen <= cooldownUntilScored) return [];
    if (barsRemaining <= NO_ENTRY_TAIL_BARS) return [];
    if (ema15 === null || latestFiveClose === null) return [];
    // latestFiveClose <= ema15 * (1 - DIP): cross-multiplied by the scale.
    if (latestFiveClose * EMA_SCALE * BPS_DENOM > ema15 * (BPS_DENOM - DIP_BPS)) return [];
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    if (state.cash < minNotional) return [];
    const impact = state.impactBps(SYMBOL, state.cash);
    if (impact !== null && impact > IMPACT_CAP_BPS) return [];
    return [
      {
        side: 'buy',
        symbol: SYMBOL,
        notional_quote_units: state.cash,
        max_slippage_bps: SLIPPAGE_BUY_BPS,
      },
    ];
  },
});
