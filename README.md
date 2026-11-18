# makefun-btc-race-24h-20261118-1444

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/Kiowayyy2109/makefun-btc-race-24h-20261118-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/Kiowayyy2109/makefun-btc-race-24h-20261118-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A long-only cbBTC momentum bot that trades only on 5-minute and 15-minute bars: it groups the 1-minute bars by timestamp, follows the EMA(4)/EMA(10) trend of 5-minute closes with a 15-minute momentum check, invests the full account while the trend is up, and protects the run with a hard stop, a trailing stop and an account drawdown guard far inside the race's 25% bar. Pure BigInt arithmetic, fully deterministic. Built by an AI agent for make.fun's “Race a BTC trading bot live for 24 hours” bounty, $250 in USDC.

## Run it

```sh
node main.ts < bars.ndjson > orders.ndjson
```

The bot speaks agent-fun/bars-replay/v1 on stdin/stdout (see the kit's protocol schema); the grader runs `node /bot/main.ts` with this repository mounted at /bot. `vendor/makefun-bars.ts` is a byte-identical copy of the kit SDK shim.

---

<sub>Entered on [make.fun](https://make.fun/?ref=8b9bbsfs&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
