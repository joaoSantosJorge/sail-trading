# Sail Trading — Implementation Plan

## Context

Greenfield product — an AI research and trading copilot for crypto: user connects an EVM wallet → app reads holdings → shows OHLCV charts → user defines/backtests strategies (AI-generated from natural language) → AI writes research reports and trade proposals grounded in the wallet + market data → user executes proposed trades from their own wallet. The app never holds keys or funds.

**Decision on the hackathon sponsor stack:** user chose *pure product, no hackathon*, solo, weeks of runway. So we skip The Graph Token API/subgraphs, ENS agent identity, and x402 for v1 (all cosmetic or higher-friction for this product), and use the easiest best-fit tools — keeping **Uniswap Trading API** because it's genuinely the best free execution option (quote → approval → swap calldata the user signs; no fee, unlike 0x's 15 bps free-tier fee).

## Integrations (researched, verified mid-2026)

- **Wallet holdings:** Alchemy Portfolio API (`getTokensByWallet`, ~300M CU/mo free, 30+ EVM chains)
- **OHLCV history:** Binance public klines (free, no key, deep minute-level history) as primary for majors; CoinGecko free demo tier (30/min, ~10k/mo) for long-tail tokens, daily history, current prices, metadata
- **Execution:** Uniswap Trading API `https://trade-api.gateway.uniswap.org/v1/` — `/quote`, `/check_approval` (Permit2), `/swap` returns calldata; free key from Uniswap Developer Portal; 3 req/s limit
- **AI:** Anthropic SDK, `claude-sonnet-5` for strategy generation and research (one knob in `ai/client.ts` to swap models), adaptive thinking, streaming, prompt caching on system prompts

## Architecture

Single Next.js 15 (App Router) + TypeScript repo, three layers:

1. **Client** — wagmi v2 + viem v2 as the base wallet layer, **RainbowKit** as the connect-kit UI (confirmed choice; WalletConnect is not an alternative to wagmi — it's a connection protocol used *through* a wagmi connector, hence `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`). Client only ever *signs* payloads the server prepares; no secrets client-side
2. **Server** — route handlers/server actions hold all integrations, the backtest engine, and DB access; all API keys server-only (Zod-validated `src/server/env.ts` with `import "server-only"`)
3. **Data** — Postgres on Neon via Drizzle (jsonb for metrics/reports/proposals; works on serverless; same `DATABASE_URL` shape locally via docker Postgres or a Neon branch)

**Core invariant: the AI never produces code, only data** — a validated JSON strategy DSL and validated JSON trade proposals. Everything AI-produced passes Zod validation + server-side clamping before touching the engine or a transaction.

Other stack: Tailwind 4 + shadcn/ui, `lightweight-charts@^5` for candles/equity curves, `vitest@^3`.

### Directory structure

```
src/
  app/
    page.tsx (dashboard), portfolio/, charts/[assetId]/,
    strategies/ (+ new/, [id]/), backtests/[id]/,
    research/ (+ [id]/), trade/[proposalId]/
    api/ candles/ portfolio/ strategies/generate/ backtests/
         research/ (SSE) trade/quote/ trade/swap/
  server/
    env.ts
    db/schema.ts db/index.ts
    market/coingecko.ts binance.ts candleCache.ts rateLimiter.ts
    portfolio/alchemy.ts
    engine/types.ts indicators.ts interpreter.ts backtest.ts metrics.ts
    ai/client.ts strategyGen.ts research.ts tools.ts prompts.ts
    uniswap/client.ts types.ts
  components/ (CandleChart, EquityCurve, StrategyEditor, ReportView, TradeConfirmModal…)
  lib/wagmi.ts
tests/ (indicators, interpreter, backtest, dsl, candleCache)
```

## Strategy representation: constrained JSON DSL (not sandboxed code)

Claude generates a **JSON strategy DSL**; a deterministic TS engine interprets it. Sandboxed model-generated JS lost because safe execution (isolated-vm/QuickJS builds, determinism, timeouts, audit burden) costs far more than the expressiveness buys in v1; the DSL is UI-renderable, diffable, and provably schema-valid via structured outputs. Migration path: discriminated `kind: "dsl" | "script"` field — a later `script` kind runs in `quickjs-emscripten` behind the same `StrategyRunner` interface without changing engine/storage/UI.

### DSL v1 (`src/server/engine/types.ts`, mirrored 1:1 in Zod)

- `indicators` (max 8): `sma | ema | rsi | macd | bbands | atr | roc | highest | lowest`, each with `id`, optional `source` price field, `params`
- `entry` / `exit`: condition trees — `gt/lt/gte/lte`, `crosses_above/crosses_below`, `and/or/not` (nesting depth ≤ 3); operands are price fields, indicator refs (with output selector for macd/bbands), or constants
- `risk`: `positionSizePct` (1–100 of equity), optional `stopLossPct`, `takeProfitPct`, `cooldownBars`
- `interval`: `15m | 1h | 4h | 1d`; long-only in v1 (spot DEX, no shorting); `version: 1`, `name`, `description` (AI's plain-English restatement shown in UI)

### Generation pipeline (`ai/strategyGen.ts`)

1. `client.messages.parse()` with `zodOutputFormat(StrategyDSLSchema)` — structured outputs guarantee schema-valid JSON
2. Semantic validation pass: indicator refs resolve, `output` matches indicator type, param ranges (period 2–500), depth ≤ 3, warm-up < available history
3. On failure: one repair round (re-call with errors appended); two failures → surface to user
4. Persist as immutable `strategies` row (`parent_id` links edits); render human-readable rules next to raw JSON for user confirmation

## Backtest engine

- **Candle:** `{ t, o, h, l, c, v }` (t = open time, ms UTC); Postgres `candles` PK `(asset_id, interval, t)`; loaded as `Candle[]` (≤ ~50k/run, no optimization needed)
- **Indicators: hand-rolled** pure functions (`sma(values, period): number[]`, index-aligned, NaN during warm-up) — the 9 needed are 10–30 lines each; `technicalindicators` is unmaintained, `indicatorts` has inconsistent NaN handling. Golden-file tests pinned to TA-Lib reference values
- **Interpreter:** precompute indicator series once; evaluate condition trees per bar; `crosses_*` compares bar i-1 vs i; any NaN operand → false
- **Fill model:** signal on closed bar i → fill at `open[i+1]` (**no lookahead ever**); long-only, one position at a time
- **Costs (run params):** `feeBps` (default 30), `slippageBps` (default 10), flat `gasUsd` (default $1) on both sides
- **Stops:** intrabar — `low[i] ≤ stop` exits at stop price (gap-below-at-open fills at `open[i]`); mirrored for take-profit
- **Deterministic:** pure `(candles, dsl, costs, initialEquity) => BacktestResult`; no Date.now/randomness
- **Metrics:** equity curve, total return, CAGR, max drawdown, Sharpe (daily-resampled, annualized √365), win rate, profit factor, trade count, time-in-market, buy-and-hold benchmark on same data/costs
- **Runs inline** in a route handler (`runtime = "nodejs"`, `maxDuration = 120`) — sub-second CPU; `backtest_runs.status` column is the escape hatch to a poll-based job pattern later
- **Storage:** `backtest_runs` with `metrics/trades/equity_curve` jsonb (curve downsampled ≤ 2,000 points; full curve recomputable)

## Data layer

Tables: `assets` (coingecko_id, symbol, chain, address, binance_symbol), `candles`, `candle_sync` (coverage watermarks), `wallets`, `holdings_snapshots`, `strategies`, `backtest_runs`, `research_reports` (report + exact inputs used), `trade_proposals` (status: proposed/approved/executed/dismissed/expired), `executions` (tx hash, quote, receipt).

**Candle caching** (`market/candleCache.ts`): fetch-through — `getCandles()` checks `candle_sync` coverage, fetches only missing spans from the right source (Binance for majors, CoinGecko for long-tail), upserts, serves from DB. Closed candles cached forever; forming candle never persisted. Price polling via batched `/simple/price` with 60s in-memory TTL. Token-bucket rate limiter: 25/min CoinGecko + monthly counter (>80% of 10k budget → serve cache, flag staleness); 10/s Binance.

## AI research pipeline

SDK tool runner (`client.beta.messages.toolRunner` + `betaZodTool`), streaming SSE from `api/research/route.ts`. Tools:

- `get_portfolio(wallet)` — Alchemy holdings + USD (snapshot persisted)
- `get_market_snapshot(assetIds[])` — price, 24h/7d/30d change, volume, distance from 90d high/low
- `get_ohlcv(assetId, interval, lookbackBars ≤ 500)` — compact summaries
- `list_backtests` / `get_backtest(runId)` — user's results as evidence
- `propose_trade(proposal)` — **strict tool**: validates TradeProposal schema, clamps server-side, persists row, returns id for citation

TradeProposal: chainId, tokenIn/tokenOut (address/symbol/decimals), sizeTokenIn (decimal string), sizeUsd, maxSlippageBps (clamped ≤ 100), rationale, risks[], confidence, invalidation. **Server-side clamps (never trusted to the model):** tokenIn must be in wallet snapshot; size ≤ balance; sizeUsd ≤ min(`MAX_PROPOSAL_USD`, `MAX_PROPOSAL_PCT` × portfolio); addresses checked against `assets` registry. Final assistant text = the markdown report, persisted with its inputs. Proposals expire after 24h.

## Execution flow (Uniswap Trading API, all server-side calls)

1. **Quote** — `POST /api/trade/quote` → Uniswap `/quote` (EXACT_INPUT, swapper = user) + `/check_approval`; returns quote (amountOut, **amountOutMinimum**, price impact, route, gas) + optional approvalTx + permitData
2. **Approval** (if needed) — client sends approval tx via wagmi `useSendTransaction`, shown as a distinct labeled step
3. **Permit** — client signs permitData via `useSignTypedData` (EIP-712, gasless)
4. **Swap** — `POST /api/trade/swap` `{ quote, signature }` → Uniswap `/swap` → `{ to, data, value }` → confirmation screen → client sends; server records `executions` row; viem `waitForTransactionReceipt` watcher updates status

**Safety rails:** size caps re-checked at quote time; confirm screen shows sell/buy amounts, minimum received, price impact (warning > 2%, hard block > 5% without explicit override), route, network fee; `to` address **verified against a hardcoded per-chain allowlist of Uniswap router/Permit2 addresses** (unknown target → block); quotes expire after 30s; nothing auto-executes.

## Env / keys

`DATABASE_URL`, `ANTHROPIC_API_KEY`, `ALCHEMY_API_KEY`, `COINGECKO_API_KEY`, `UNISWAP_API_KEY`, `MAX_PROPOSAL_USD`, `MAX_PROPOSAL_PCT`; only `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` client-visible. `.env.example` checked in, `.env.local` gitignored. Auth v1 = connected wallet address (SIWE deferred).

## Milestones (each independently demoable)

**M1 — Scaffold + market data + charts.** create-next-app, Tailwind, shadcn, Drizzle+Neon, env module, vitest, CI. Asset registry (~20 seeded majors + CoinGecko search), Binance/CoinGecko clients, candle cache, rate limiter, `/charts/[assetId]` candlestick chart with interval switcher.
*Done:* ETH 1h chart renders 2 years of history; reload serves from DB (logged fetch counts); cache test proves gap-filling fetches only missing ranges (mocked HTTP).

**M2 — Strategy DSL + backtest engine** (deterministic core before AI). DSL types + Zod, indicators with golden tests, interpreter, backtest loop, metrics, persistence, results UI (equity/drawdown curves, trade markers, metrics vs buy-and-hold), manual strategy form (doubles as DSL renderer).
*Done:* SMA-crossover on ETH 1d is plausible and reproducible (same run twice → identical metrics); no-lookahead test passes (truncating future candles never changes past signals).

**M3 — AI strategy generation** (risk isolated: engine already exists, this is only NL→DSL). `strategyGen.ts` + `/strategies/new` chat page: prompt → streamed generation → readable rules → confirm → backtest.
*Done:* 10-prompt eval fixture yields ≥ 9 valid strategies matching intent; "buy when RSI < 30…" flows end-to-end in the UI.

**M4 — Wallet + portfolio.** RainbowKit/wagmi, Alchemy integration (Ethereum/Base/Arbitrum), spam-token filtering, snapshots, `/portfolio` page.
*Done:* real wallet shows holdings across ≥ 2 chains matching a block explorer; disconnected state handled.

**M5 — AI research + proposals.** Tool suite + runner loop, SSE report UI, proposal cards, clamps, expiry.
*Done:* report against real wallet with every claim traceable to a logged tool call; oversized proposal clamped/rejected in a test.

**M6 — Trade execution.** Uniswap client, `/trade/[proposalId]` flow UI, router allowlist, execution recording + receipt watcher.
*Done:* on **Base with ~$10 real funds**: approval → permit → confirm (minimum-received matches quote) → swap lands, received ≥ amountOutMinimum. Negative tests: expired quote blocks, unknown `to` blocks, price-impact hard block on illiquid pair.

Ordering rationale: M2 before M3 so the AI milestone is isolated to generation quality; wallet/execution last (integration-shaped, least uncertain).

## Verification approach

Per milestone as above; overall: vitest suites for indicators (golden values), interpreter, backtest determinism/no-lookahead, DSL validation, candle cache (mocked HTTP); live-API manual evals for strategy generation; a real small-money swap on Base as the final end-to-end proof.

## Critical files

- `src/server/engine/types.ts` — DSL type + Zod schema; contract between AI, engine, DB, UI
- `src/server/engine/backtest.ts` — deterministic simulation loop
- `src/server/ai/strategyGen.ts` — NL → DSL structured outputs + validation/repair
- `src/server/market/candleCache.ts` — fetch-through OHLCV cache + source routing
- `src/server/db/schema.ts` — Drizzle schema
