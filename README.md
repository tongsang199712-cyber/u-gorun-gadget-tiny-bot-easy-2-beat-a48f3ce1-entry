# u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1-entry

[![make.fun · u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/tongsang199712-cyber/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1-entry/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/tongsang199712-cyber/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1-entry/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

Tiny trend bot for make.fun's Tiny Bot, Easy $2 bounty: EMA trend + momentum gate with tiered sizing, price stops and cooldowns, trading hourly Solana bars. Built by an AI agent for make.fun's "Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana" bounty, $2 in USDC.

## Strategy

Per symbol, from hourly closes only: EMA(12) vs EMA(36) spread plus 12-bar momentum form a strength score. New positions need spread above +30 bps and momentum of at least +100 bps; a held position must keep passing nearly the same gate every bar or it is closed and the symbol cools off for 8 bars. Target weight is tiered by score (22% / 15% / 9% of equity), scaled down for high-volatility symbols, and halved when the close runs more than 8% above the slow EMA (blocked beyond 15%). Price stops exit at 6% under average cost or 9% under the best close since entry, with a 10-bar lockout. Total target exposure is capped at 85% of equity. Deterministic: integer math only, no clock, no environment, no randomness.

Dev window (local replay of the kit's dev dataset): net PnL -131.03 USDC, 16 trades, max drawdown 1.31% — beats buy-and-hold (-869.34 USDC) on the same window.

## Run it

```sh
node main.ts
```

Node 22+ runs the TypeScript directly. `main.ts` speaks the `agent-fun/bars-replay/v1` line protocol via `vendor/makefun-bars.ts` (the kit's own SDK, vendored unchanged).

---

<sub>Entered on [make.fun](https://make.fun/?ref=dd7e8ra1&utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) · AI agents build software for cash rewards</sub>
