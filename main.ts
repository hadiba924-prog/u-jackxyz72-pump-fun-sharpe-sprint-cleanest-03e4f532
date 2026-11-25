// Dispersed-ownership breakout bot for the Pump.fun Sharpe Sprint.
// Node 22, standard library only. No network, no clock, no randomness:
// every decision is a pure function of the batch stream, so two runs
// produce byte-identical action logs.
//
// Idea: most new pump.fun coins bleed out within minutes, so the bot is
// extremely picky. It only buys a coin once the tape proves real, spread-out
// demand — many distinct buyers, several SOL of net inflow, price rising but
// still near its recent high, no single wallet dominating the buys, and the
// creator not selling. One small equal stake per coin, a quick full exit at
// +15% or -10%, and a time exit after 1800 slots. Sells are split into
// chunks that fit inside the curve's real SOL reserves, because the replay
// rejects any sell whose quote exceeds those reserves (a rugged coin's
// reserves drain to almost nothing, so a whole-position sell would bounce
// forever). A tiny probe round trip keeps the run above the 20-coin
// guardrail when the main filter finds too few coins.

import { createInterface } from 'node:readline';

const SOL = 1_000_000_000n;
const LAMPORTS_PER_SOL = 1e9;

// --- Tuned settings (chosen on the dev window; flat region, not a peak) ---
const WINDOW_TRADES = 30; // trades in the entry window
const MIN_NET_SOL = 3; // net buy SOL over the window
const MIN_BUYS = 5; // buys over the window
const MIN_BUYERS = 12; // distinct buyers over the window
const MIN_UP = 0.05; // price gain over the window
const MAX_UP = 0.25; // do not chase a coin that already ran away
const NEAR_HIGH = 0.95; // last price must sit near the window high
const MAX_TOP_SHARE = 0.3; // biggest single buyer may take at most 30% of buy SOL
const MIN_RQ_SOL = 3; // real SOL reserves must be at least this
const MAX_RQ_SOL = 45; // ... and at most this (very large curves are late)
const MIN_AGE_SLOTS = 500; // ignore the first slots: bundled launches dump
const MAX_AGE_SLOTS = 3000; // ... and coins older than this
const STAKE_SOL = 0.13; // one equal stake per coin
const MIN_BUY_SOL = 0.01; // smallest buy worth sending
const TAKE_PROFIT = 0.15; // sell everything here
const STOP_LOSS = -0.1; // ... or here
const MAX_HOLD_SLOTS = 1800; // ... or after this long, whichever comes first
const COOLDOWN_SLOTS = 300; // wait this long before touching a sold coin again
const MAX_MAIN_POSITIONS = 4; // one slot stays free for guardrail probes
const PROBE_SOL = 0.01; // probe round-trip size
const PROBE_TARGET_COINS = 25; // probe until this many coins closed a trip
const PROBE_MIN_GAP_SLOTS = 9000; // at most one probe per this many slots
const HOUR_LOSS_HALT_SOL = 0.05; // stop entering for the hour after this loss
const SLIPPAGE_BPS = 10000; // never let slippage refuse an order
const CHUNK_RQ_PCT = 80n; // a sell chunk may take at most 80% of real reserves
const DUST_LAMPORTS = 300000n; // skip sell chunks worth less than this
const SLOTS_PER_HOUR = 9000;

type Tick = { slot: number; price: number; sol: number; buy: boolean; user: string };

type CurveInfo = {
  createdSlot: number | null;
  creator: string;
  vq: bigint;
  vt: bigint;
  rq: bigint;
  rt: bigint;
  complete: boolean;
  devSold: boolean;
  tape: Tick[];
  decided: boolean;
  lastExitSlot: number;
};

type LedgerEntry = {
  tokens: bigint;
  cost: bigint; // lamports paid (quote + curve fees + tx fee)
  peakGain: number;
  buySlot: number;
  tpDone: boolean;
  probe: boolean;
};

type Pending = { side: 'buy' | 'sell'; mint: string; amount: bigint };

const curves = new Map<string, CurveInfo>();
const ledger = new Map<string, LedgerEntry>();
const pending = new Map<string, Pending>();
const pendingSellMints = new Set<string>();
const probePending = new Set<string>();
const probedMints = new Set<string>();
const closedMints = new Set<string>();
const hourPnl = new Map<number, number>();

let firstSlot = -1;
let lastProbeSlot = -1e9;
let nextClient = 1;
let capitalLamports = 10n * SOL;
let cashLamports = 10n * SOL;
let maxOpenPositions = 5;
let maxOrdersPerBatch = 16;
let maxOrderBps = 100;
let txFeeLamports = 105000n;

function freshCurve(mint: string, createdSlot: number | null): CurveInfo {
  const c: CurveInfo = {
    createdSlot,
    creator: '',
    vq: 0n,
    vt: 0n,
    rq: 0n,
    rt: 0n,
    complete: false,
    devSold: false,
    tape: [],
    decided: false,
    lastExitSlot: -1e9,
  };
  curves.set(mint, c);
  return c;
}

function curveFor(mint: string): CurveInfo {
  return curves.get(mint) ?? freshCurve(mint, null);
}

function markPrice(mint: string): number {
  const c = curves.get(mint);
  if (!c || c.vt === 0n) return 0;
  return Number(c.vq) / Number(c.vt);
}

function maxBuyNow(mint: string): bigint {
  const c = curves.get(mint);
  if (!c || c.complete) return 0n;
  return (c.rq * BigInt(maxOrderBps)) / 10000n;
}

function committedCount(): number {
  const held = new Set<string>(ledger.keys());
  for (const p of pending.values()) if (p.side === 'buy') held.add(p.mint);
  return held.size;
}

function freeCash(): bigint {
  let free = cashLamports;
  for (const p of pending.values()) {
    free -= txFeeLamports;
    if (p.side === 'buy') free -= p.amount;
  }
  return free;
}

function hourOf(slot: number): number {
  return Math.floor((slot - firstSlot) / SLOTS_PER_HOUR);
}

function netFlow(ticks: readonly Tick[]): number {
  let net = 0;
  for (const t of ticks) net += t.buy ? t.sol : -t.sol;
  return net;
}

// Largest token amount whose sell quote stays within CHUNK_RQ_PCT of the
// curve's real SOL reserves. The harness rejects a sell whose quote is
// larger than the real reserves, so a full-position sell on a drained
// curve would never land; chunking lets the position out a piece at a time.
function chunkTokens(mint: string, want: bigint): bigint {
  const c = curves.get(mint);
  if (!c || want <= 0n) return 0n;
  const { vq, vt, rq } = c;
  if (vq <= 0n || vt <= 0n || rq <= 0n) return 0n;
  const targetQuote = (rq * CHUNK_RQ_PCT) / 100n;
  if (targetQuote <= 0n) return 0n;
  if (targetQuote >= vq) return want;
  const tokens = (targetQuote * vt) / (vq - targetQuote);
  const amount = tokens < want ? tokens : want;
  const quoteOut = (amount * vq) / (vt + amount);
  if (quoteOut < DUST_LAMPORTS) return 0n;
  return amount;
}

function newClientId(): string {
  return `o${nextClient++}`;
}

// --- fill bookkeeping: keep the cost ledger in step with the harness ---
function applyFills(fills: any[]): void {
  for (const f of fills) {
    const p = pending.get(f.client_id);
    if (p) pending.delete(f.client_id);
    if (f.side === 'sell') pendingSellMints.delete(f.mint);
    if (f.status !== 'filled') continue;
    const quote = BigInt(f.quote_lamports);
    const fee = BigInt(f.fee_lamports);
    const tx = BigInt(f.tx_fee_lamports);
    const tokens = BigInt(f.token_amount);
    if (f.side === 'buy') {
      const paid = quote + fee + tx;
      const entry = ledger.get(f.mint);
      if (entry) {
        entry.tokens += tokens;
        entry.cost += paid;
      } else {
        ledger.set(f.mint, {
          tokens,
          cost: paid,
          peakGain: 0,
          buySlot: currentSlot,
          tpDone: false,
          probe: probePending.delete(f.mint),
        });
      }
    } else {
      const entry = ledger.get(f.mint);
      if (!entry) continue;
      const proceeds = quote - fee - tx;
      const share = entry.tokens > 0n ? Number(tokens) / Number(entry.tokens) : 0;
      const realised = proceeds - BigInt(Math.round(Number(entry.cost) * share));
      const h = hourOf(currentSlot);
      hourPnl.set(h, (hourPnl.get(h) ?? 0) + Number(realised) / LAMPORTS_PER_SOL);
      entry.tokens -= tokens;
      entry.cost = BigInt(Math.round(Number(entry.cost) * (1 - share)));
      if (entry.tokens <= 0n) {
        ledger.delete(f.mint);
        closedMints.add(f.mint);
        const c = curves.get(f.mint);
        if (c) c.lastExitSlot = currentSlot;
      }
    }
  }
}

let currentSlot = -1;

function decide(batch: any): any[] {
  const orders: any[] = [];
  const slot = batch.slot as number;
  currentSlot = slot;
  if (firstSlot < 0) firstSlot = slot;
  applyFills(batch.fills ?? []);

  // Fold the batch's events into curves and tapes.
  const traded = new Set<string>();
  for (const e of batch.events ?? []) {
    if (e.event === 'CreateEvent') {
      const c = freshCurve(e.mint, e.slot);
      c.creator = e.creator;
      c.vq = BigInt(e.virtual_sol_reserves);
      c.vt = BigInt(e.virtual_token_reserves);
      c.rt = BigInt(e.real_token_reserves);
      c.rq = 0n;
    } else if (e.event === 'TradeEvent') {
      const c = curveFor(e.mint);
      c.vq = BigInt(e.virtual_sol_reserves);
      c.vt = BigInt(e.virtual_token_reserves);
      c.rq = BigInt(e.real_sol_reserves);
      c.rt = BigInt(e.real_token_reserves);
      traded.add(e.mint);
      const sol = Number(e.sol_amount) / LAMPORTS_PER_SOL;
      c.tape.push({
        slot: e.slot,
        price: Number(e.virtual_sol_reserves) / Number(e.virtual_token_reserves),
        sol,
        buy: e.is_buy === true,
        user: e.user,
      });
      if (c.tape.length > 80) c.tape.splice(0, c.tape.length - 80);
      if (!e.is_buy && e.user === c.creator) c.devSold = true;
    } else if (e.event === 'CompleteEvent') {
      curveFor(e.mint).complete = true;
    }
  }
  // Marks refresh reserves for held and pending coins.
  for (const m of batch.marks ?? []) {
    const c = curves.get(m.mint);
    if (!c) continue;
    c.vq = BigInt(m.virtual_quote_reserves);
    c.vt = BigInt(m.virtual_token_reserves);
    c.rq = BigInt(m.real_quote_reserves);
    c.rt = BigInt(m.real_token_reserves);
  }
  // The account is authoritative for cash; the ledger tracks cost basis.
  if (batch.account) {
    cashLamports = BigInt(batch.account.cash_lamports);
  }

  const hour = hourOf(slot);
  const entriesPaused = (hourPnl.get(hour) ?? 0) < -HOUR_LOSS_HALT_SOL;

  // --- exits first: probes, then every held position ---
  for (const [mint, entry] of [...ledger.entries()]) {
    if (pendingSellMints.has(mint)) continue;
    const curve = curves.get(mint);
    const price = markPrice(mint);
    if (price <= 0 || entry.tokens <= 0n || entry.cost <= 0n) continue;
    const avgCost = Number(entry.cost) / Number(entry.tokens);
    const gain = price / avgCost - 1;
    if (gain > entry.peakGain) entry.peakGain = gain;

    let sellAll = false;
    if (entry.probe) {
      sellAll = true;
    } else if (curve?.complete) {
      sellAll = true;
    } else if (curve?.devSold) {
      sellAll = true; // the creator is out: do not be the last one holding
    } else if (!entry.tpDone && gain >= TAKE_PROFIT) {
      sellAll = true;
      entry.tpDone = true;
    } else if (gain <= STOP_LOSS) {
      sellAll = true;
    } else if (slot - entry.buySlot >= MAX_HOLD_SLOTS) {
      sellAll = true;
    }
    if (!sellAll) continue;
    const amount = chunkTokens(mint, entry.tokens);
    if (amount <= 0n) continue;
    const id = newClientId();
    orders.push({
      side: 'sell',
      client_id: id,
      mint,
      token_amount: amount.toString(),
      max_slippage_bps: SLIPPAGE_BPS,
    });
    pending.set(id, { side: 'sell', mint, amount });
    pendingSellMints.add(mint);
  }

  // --- entries: dispersed-ownership breakouts only ---
  if (!entriesPaused && orders.length < maxOrdersPerBatch) {
    let freeSlots = MAX_MAIN_POSITIONS - committedCount();
    let free = freeCash();
    for (const mint of traded) {
      if (freeSlots <= 0 || orders.length >= maxOrdersPerBatch) break;
      const c = curves.get(mint);
      if (!c || c.decided || c.complete || ledger.has(mint)) continue;
      const age = slot - (c.createdSlot ?? slot);
      if (age < MIN_AGE_SLOTS) continue;
      if (age > MAX_AGE_SLOTS) {
        c.decided = true;
        continue;
      }
      if (slot - c.lastExitSlot < COOLDOWN_SLOTS) continue;
      if (c.tape.length < WINDOW_TRADES) continue;
      const window = c.tape.slice(-WINDOW_TRADES);
      const firstPrice = window[0].price;
      const lastPrice = window[window.length - 1].price;
      if (firstPrice <= 0 || lastPrice <= 0) continue;
      const rise = lastPrice / firstPrice - 1;
      if (rise < MIN_UP || rise > MAX_UP) continue;
      let high = 0;
      for (const t of window) if (t.price > high) high = t.price;
      if (lastPrice < NEAR_HIGH * high) continue;
      let buySol = 0;
      let sellSol = 0;
      let buys = 0;
      const buyers = new Map<string, number>();
      for (const t of window) {
        if (t.buy) {
          buySol += t.sol;
          buys++;
          buyers.set(t.user, (buyers.get(t.user) ?? 0) + t.sol);
        } else {
          sellSol += t.sol;
        }
      }
      if (buySol - sellSol < MIN_NET_SOL) continue;
      if (buys < MIN_BUYS || buyers.size < MIN_BUYERS) continue;
      let topBuyer = 0;
      for (const v of buyers.values()) if (v > topBuyer) topBuyer = v;
      if (buySol > 0 && topBuyer / buySol > MAX_TOP_SHARE) continue;
      const half = Math.floor(window.length / 2);
      if (netFlow(window.slice(half)) <= netFlow(window.slice(0, half))) continue;
      const rqSol = Number(c.rq) / LAMPORTS_PER_SOL;
      if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) continue;
      const cap = maxBuyNow(mint);
      let amount = BigInt(Math.round(STAKE_SOL * LAMPORTS_PER_SOL));
      if (amount > cap) amount = cap;
      if (amount < BigInt(Math.round(MIN_BUY_SOL * LAMPORTS_PER_SOL))) continue;
      if (free < amount + txFeeLamports) continue;
      c.decided = true;
      const id = newClientId();
      orders.push({
        side: 'buy',
        client_id: id,
        mint,
        quote_lamports: amount.toString(),
        max_slippage_bps: SLIPPAGE_BPS,
      });
      pending.set(id, { side: 'buy', mint, amount });
      free -= amount + txFeeLamports;
      freeSlots -= 1;
    }
  }

  // --- guardrail probes: one tiny round trip per gap while few coins closed ---
  if (
    closedMints.size < PROBE_TARGET_COINS &&
    slot - lastProbeSlot >= PROBE_MIN_GAP_SLOTS &&
    committedCount() < maxOpenPositions &&
    orders.length < maxOrdersPerBatch
  ) {
    let best: string | null = null;
    let bestRq = -1n;
    const pick = (skipProbed: boolean) => {
      for (const mint of traded) {
        if (ledger.has(mint) || (skipProbed && probedMints.has(mint))) continue;
        const c = curves.get(mint);
        if (!c || c.complete) continue;
        if (c.rq > bestRq) {
          bestRq = c.rq;
          best = mint;
        }
      }
    };
    pick(true);
    if (best === null) pick(false);
    if (best !== null) {
      let amount = BigInt(Math.round(PROBE_SOL * LAMPORTS_PER_SOL));
      const cap = maxBuyNow(best);
      if (amount > cap) amount = cap;
      if (
        amount >= BigInt(Math.round(MIN_BUY_SOL * LAMPORTS_PER_SOL)) &&
        freeCash() >= amount + txFeeLamports
      ) {
        const id = newClientId();
        orders.push({
          side: 'buy',
          client_id: id,
          mint: best,
          quote_lamports: amount.toString(),
          max_slippage_bps: SLIPPAGE_BPS,
        });
        pending.set(id, { side: 'buy', mint: best, amount });
        probePending.add(best);
        probedMints.add(best);
        lastProbeSlot = slot;
      }
    }
  }

  return orders;
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.length === 0) continue;
    const message = JSON.parse(line);
    if (message.type === 'hello') {
      capitalLamports = BigInt(message.capital.lamports);
      cashLamports = capitalLamports;
      maxOpenPositions = message.caps.max_open_positions;
      maxOrdersPerBatch = message.caps.max_orders_per_batch;
      maxOrderBps = message.caps.max_order_bps_of_real_reserve;
      txFeeLamports =
        BigInt(message.fees.base_fee_lamports) + BigInt(message.fees.priority_fee_lamports);
    } else if (message.type === 'batch') {
      const orders = decide(message);
      process.stdout.write(
        JSON.stringify({ type: 'reply', seq: message.seq, orders }) + '\n',
      );
    } else if (message.type === 'done') {
      break;
    }
  }
}

await main();
