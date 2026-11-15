// Surge-momentum cbBTC bot for make.fun bars-replay/v1.
//
// Strategy (the opposite direction from a dip-buying bot: this one buys
// strength, not weakness):
//
// * Entry: the close has risen at least 75 bps over the last 5 minutes AND
//   the 15-minute return is not negative. A 5-minute surge that is just a
//   spike inside a downtrend is filtered out by the 15-minute confirmation.
//   The whole cash balance goes in, long only, one position at a time.
// * Exit: the whole position is sold when the close falls 60 bps below the
//   highest close seen since entry (trailing stop), or after 120 bars in
//   the trade (max hold), whichever comes first.
//
// Why these numbers: on the published dev window a 5-minute rise above
// 80 bps is followed by a positive 30-minute drift on average (mean
// +87 bps, median +148 bps), while buying 5-minute drops loses money, so
// momentum continuation is the edge here. The 75 bps / 60 bps / 120-bar
// centre sits in a flat-positive neighbourhood (70-80 bps entry, 50-80 bps
// trail all positive with the 15-minute confirmation), not on a knife edge.
//
// All arithmetic is bigint (basis points from integer closes), there is no
// clock, no randomness, no file or environment read, so two runs on the
// same bars produce byte-identical replies.

import { runBars } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const SURGE_BPS = 75n; // 5-minute rise that triggers an entry
const CONFIRM_BARS = 15; // 15-minute return must be non-negative
const TRAIL_BPS = 60n; // exit when the close falls this far below the peak close
const MAX_HOLD = 120; // exit after this many bars in the trade
const MAX_SLIPPAGE_BPS = 300; // 3% past the close the order was decided on

const closes = [];
let inTrade = false;
let entryClose = 0n;
let entrySeq = -1;
let peakClose = 0n;
let holdBars = 0;

/** Return of now vs then, in basis points, truncated (bigint math). */
function bps(now, then) {
  return (now * 10000n) / then - 10000n;
}

await runBars({
  onBatch(state, batch) {
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) closes.push(BigInt(bar.c));
    }
    if (state.warmingUp) return [];
    const position = state.positions.get(SYMBOL);
    if (position === undefined) {
      inTrade = false;
      if (closes.length < CONFIRM_BARS + 1) return [];
      const close = closes[closes.length - 1];
      const surge = bps(close, closes[closes.length - 6]);
      const confirm = bps(close, closes[closes.length - 16]);
      if (surge >= SURGE_BPS && confirm >= 0n) {
        const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
        if (state.cash < minNotional) return [];
        entryClose = close;
        entrySeq = state.seq;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }
    const close = closes[closes.length - 1];
    if (!inTrade) {
      // First batch holding this position: seed the peak from the close
      // the buy was decided on (the fill bar's close can only raise it).
      inTrade = true;
      peakClose = state.seq === entrySeq + 1 && entryClose > close ? entryClose : close;
      holdBars = 1;
    } else {
      holdBars += 1;
      if (close > peakClose) peakClose = close;
    }
    const retrace = ((peakClose - close) * 10000n) / peakClose;
    if (retrace >= TRAIL_BPS || holdBars >= MAX_HOLD) {
      return [{ side: 'sell', symbol: SYMBOL, qty: position.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
