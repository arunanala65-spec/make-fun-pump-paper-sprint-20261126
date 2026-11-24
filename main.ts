// Fresh-momentum scalper for pump.fun paper trading (agent-fun/replay/v2).
//
// Idea: on pump.fun most new coins die fast, but the ones buyers are piling
// into right now keep running for a little while. This bot buys a coin only
// after it has already shown real buy pressure (price up over its last few
// trades, mostly buys), then gets out fast: take profit, stop loss, a trailing
// stop once it is in profit, and a hard time stop so no coin is held all day.
// Every decision comes only from the harness state (hello, batch, orders,
// slot) — no clock, no randomness, no network — so two runs agree byte for
// byte. Paper trading only; nothing here ever touches real funds.

import { runBot, LAMPORTS_PER_SOL, type BotState, type Batch, type OrderInput } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL; // 1_000_000_000n lamports
const BUY_SIZE = (SOL * 3n) / 10n; // 0.30 SOL per entry
const MIN_BUY = SOL / 20n; // 0.05 SOL: below this a round trip is not worth the fees
const CASH_RESERVE = SOL / 2n; // keep 0.5 SOL unspent as a buffer
const MAX_POSITIONS = 3;

// Buy trigger: price up this much over the last LOOKBACK trades, with most
// of those trades being buys.
const LOOKBACK = 8;
const MIN_RISE = 0.5;
const MIN_BUY_SHARE = 0.95;

// Exits, all measured against the entry price recorded from the buy fill.
const TAKE_PROFIT = 1.6; // +60%
const STOP_LOSS = 0.9; // -10%
const TRAIL_FROM_PEAK = 0.9; // give back at most 10% from the best price seen
const MAX_HOLD_SLOTS = 1200; // ~8 minutes of slots, then exit whatever the price

const BUY_SLIPPAGE_BPS = 800;
const SELL_SLIPPAGE_BPS = 1000;

interface CoinTrack {
  prices: number[]; // last LOOKBACK trade prices (SOL per token), oldest first
  buys: boolean[]; // buy flag per price in the same window, oldest first
}

interface Held {
  entryPrice: number; // SOL per token paid (fees included, from the buy fill)
  peakPrice: number; // best price seen since entry
  entrySlot: number; // slot the buy fill resolved at
}

const tracks = new Map<string, CoinTrack>();
const held = new Map<string, Held>();

function priceOf(state: BotState, mint: string): number {
  const c = state.curves.get(mint);
  if (!c || c.virtual_token_reserves === 0n) return 0;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];

    // 1. Fold this batch's fills into the entry book first.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.side === 'buy') {
        const tokens = BigInt(f.token_amount);
        if (tokens > 0n) {
          held.set(f.mint, {
            entryPrice: Number(BigInt(f.quote_lamports)) / Number(tokens),
            peakPrice: 0,
            entrySlot: f.slot,
          });
        }
      } else {
        held.delete(f.mint);
      }
    }

    // 2. Update price tracks from this batch's trades, keeping a parallel
    // queue of buy flags so the buy share over the window is exact.
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      const price = Number(BigInt(e.virtual_quote_reserves)) / Number(BigInt(e.virtual_token_reserves));
      let t = tracks.get(e.mint);
      if (!t) {
        t = { prices: [], buys: [] };
        tracks.set(e.mint, t);
      }
      t.prices.push(price);
      t.buys.push(e.is_buy);
      if (t.prices.length > LOOKBACK) {
        t.prices.shift();
        t.buys.shift();
      }
    }

    // 3. Exits first: every held position is checked against its exit rules.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      if (!pos) {
        held.delete(mint);
        continue;
      }
      const p = priceOf(state, mint);
      if (p <= 0) continue;
      if (p > h.peakPrice) h.peakPrice = p;
      const up = p / h.entryPrice;
      const heldSlots = state.slot - h.entrySlot;
      const exit =
        up >= TAKE_PROFIT ||
        up <= STOP_LOSS ||
        (h.peakPrice > h.entryPrice && p <= h.peakPrice * TRAIL_FROM_PEAK) ||
        heldSlots >= MAX_HOLD_SLOTS;
      if (exit) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      }
    }

    // 4. Entries: fresh momentum on coins we do not already hold.
    if (state.committedPositionCount() < MAX_POSITIONS) {
      let free = state.freeCashLamports() - CASH_RESERVE;
      for (const [mint, t] of tracks) {
        if (orders.length >= 8) break;
        if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= MAX_POSITIONS) break;
        if (held.has(mint) || state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (!curve || curve.complete || t.prices.length < LOOKBACK) continue;
        const first = t.prices[0];
        const last = t.prices[t.prices.length - 1];
        if (first <= 0 || last / first - 1 < MIN_RISE) continue;
        // Buy pressure: most of the window's trades must be buys, not sells.
        const buyCount = t.buys.reduce((n, b) => n + (b ? 1 : 0), 0);
        if (buyCount / t.buys.length < MIN_BUY_SHARE) continue;
        const cap = state.maxBuyLamports(mint);
        let size = BUY_SIZE;
        if (size > cap) size = cap;
        if (size > free) size = free;
        if (size < MIN_BUY) continue;
        orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
        free -= size;
      }
    }

    return orders;
  },
});
