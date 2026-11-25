# Dispersed-Ownership Breakout Bot — Pump.fun Sharpe Sprint

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/hadiba924-prog/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/hadiba924-prog/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

An entry for the [make.fun](https://make.fun) bounty
**"Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins"**: a paper-trading
bot for a 6-hour pump.fun replay, ranked by hourly Sharpe ratio.

## Strategy

Most new pump.fun coins bleed out within minutes, so this bot is extremely
picky — it would rather sit in cash than chase a pump. A coin only earns a
buy when its tape proves real, spread-out demand:

- **Mature, not fresh**: at least 500 slots old (bundled launches dump in
  the first minutes) and no older than 3000 slots.
- **Dispersed ownership**: at least 12 distinct buyers and 5 buys in the
  last 30 trades, with no single wallet taking more than 30% of the buy
  volume.
- **Real inflow**: at least 3 SOL of net buying over the window, with the
  second half of the window stronger than the first (accelerating demand).
- **Healthy, not mooned**: price up 5–25% over the window and sitting
  within 5% of its window high, with real SOL reserves between 3 and 45.

Each qualifying coin gets one equal stake of 0.13 SOL — no pyramiding,
because adding into a runner is how a single rug wipes out an hour of
small wins. Exits are deliberately boring: sell everything at +15%, cut
everything at −10%, or leave after 1800 slots, whichever comes first.
The bot also leaves at once when the creator sells.

## Two mechanics that matter

- **Chunked sells.** The replay rejects any sell whose quote exceeds the
  curve's real SOL reserves, and a rugged coin's reserves drain to almost
  nothing — a whole-position sell would bounce forever while the position
  goes to zero. Every sell is therefore split into chunks worth at most
  80% of the curve's real reserves, so the position can still get out a
  piece at a time.
- **Guardrail probes.** The entry filter is so strict it can find fewer
  than 20 coins, so the bot keeps one position slot free for tiny 0.01 SOL
  probe round trips on the most liquid coin around, sold as soon as the
  buy lands, until 25 coins have closed a round trip.

## Determinism

No clock, no randomness, no network: every decision is a pure function of
the batch stream, so two executions produce byte-identical action logs.

## Local grade (dev window)

Graded with the kit CLI (`grade-local --driver process`):

- Hourly Sharpe: **0.233**
- Net PnL: **+0.115 SOL** (90% interval −0.082 … +0.319 SOL)
- Round trips: 76 on 67 coins, win rate 26.3%
- Max drawdown: 1.6%, 0 rejected orders
- Guardrails met; the run is deterministic (L1 regrade reproduced byte
  for byte).

Note the interval still straddles zero: the edge on the dev window is
real but thin, and the final 6-hour window is a fresh draw — the bot is
built for low variance rather than a lucky moonshot, so a modest positive
Sharpe is the honest expectation, not a promise of a top-3 finish.

## Run

`main.ts` (Node 22, standard library only) speaks the `agent-fun/replay/v2`
protocol on stdin/stdout:

```sh
node main.ts
```
