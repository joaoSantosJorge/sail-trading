# Sail Trading

An AI research and trading platform for crypto. Connect a wallet, explore market
data, define and backtest strategies (AI-generated from natural language), get AI
research reports and trade proposals, and execute trades from your own wallet.
**The app never holds your keys or funds** — it prepares transactions; you sign
them.

## Status

The app is chat-centric: a persistent AI assistant (docked right, with saved
history) drives research over your assets, strategies, and backtests.

- ✅ **Phase A** (`feat/app-shell-chat`) — auth (NextAuth v5), app shell
  (sidebar sections + resizable chat dock), AI chat with server-persisted
  threads, read/render tools over market + strategy data, approval-gated
  `create_strategy` / `run_backtest` from chat. Includes prior M1–M3
  foundations (candle cache, DSL + deterministic engine, NL→DSL).
- ✅ **Phase B** (`feat/sections`) — wallet connect (RainbowKit) + Alchemy
  holdings sync, TradingView-like asset view (overlays, stats, per-asset news,
  Ask AI), CryptoPanic market news with a fetch-through cache, Documents hub
  (strategies/backtests/reports/proposals), chat memory + portfolio/news tools
  + save_research_report
- ✅ **Phase C** (`feat/trade`) — trade proposals from chat (validated against
  the wallet snapshot with hard size caps, 24h expiry), review page with the
  Uniswap execution stepper: quote (30s validity) → one-time approval →
  Permit2 signature → confirm & swap, price-impact warnings (>2%) and hard
  block (>5%), router-allowlist check on every transaction target, on-chain
  receipt verification before anything is marked executed. Requires
  `UNISWAP_API_KEY`; the wallet signature is the sole authorization.

Design docs: [`docs/PLAN.md`](docs/PLAN.md) (original milestones),
[`docs/assistant.md`](docs/assistant.md) (chat architecture).

## Prerequisites

- **Node.js 20+** and **pnpm** (`npm i -g pnpm`)
- **Postgres 16** — via **podman** or docker (a local container is fine)
- **Anthropic API key** for AI features (M3+)

## Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Start a local Postgres (podman shown; docker is identical)
podman run -d --name sail-postgres -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=sail \
  docker.io/library/postgres:16-alpine

# 3. Configure environment
cp .env.example .env.local
#   defaults match the container above; add ANTHROPIC_API_KEY for AI features
#   and set AUTH_SECRET (openssl rand -base64 32)

# 4. Create the schema and seed ~20 major assets
pnpm db:migrate
pnpm db:seed
```

After a reboot, restart the database container with `podman start sail-postgres`.

## Running the app

```bash
pnpm dev
```

Then open **http://localhost:3000** and sign in (seeded dev user:
`dev@local.test` / `password123`, or register). Sections:

- **Analyse Assets** — three tabs: **Tokens** (majors ranked by Binance 24h
  volume; per-asset TradingView-style chart with drawing tools, indicators and
  5m–1M intervals), **Macro** (CPI, rates, Fed balance sheet, M2… — FRED with
  keyless DBnomics fallback), **My Charts** (saved layouts + drawings)
- **Documents → Strategies** — saved strategies, backtest launcher, results
- **Connect Wallets / Market News / Trade** — placeholders until phases B/C
- **Chat (right dock)** — the AI assistant: ask about assets, chart price
  action inline, create strategies and run backtests with approval cards

For a production build: `pnpm build && pnpm start`.

## Environment variables

Set in `.env.local` (never committed). Only `NEXT_PUBLIC_*` reaches the browser.

| variable | needed for | notes |
|---|---|---|
| `DATABASE_URL` | everything | e.g. `postgresql://postgres:postgres@localhost:5432/sail` |
| `ANTHROPIC_API_KEY` | AI strategy generation (M3+) | from console.anthropic.com |
| `COINGECKO_API_KEY` | optional | higher rate limit for long-tail assets |
| `ALCHEMY_API_KEY` | wallet holdings sync | from alchemy.com |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect QR/mobile | from cloud.reown.com; injected wallets work without it |
| `CRYPTOPANIC_API_KEY` | market news | from cryptopanic.com/developers |
| `FRED_API_KEY` | macro series (optional) | free from fred.stlouisfed.org; without it the keyless DBnomics fallback covers most series but its BLS mirror (CPI, unemployment) lags, and fed-balance-sheet/dxy stay empty |
| `UNISWAP_API_KEY` | trade quoting + execution | from the Uniswap developer portal |
| `MAX_PROPOSAL_USD` / `MAX_PROPOSAL_PCT` | AI proposal size caps | defaults 1000 / 25 |

## Commands

| command | what |
|---|---|
| `pnpm dev` | dev server on :3000 |
| `pnpm build` / `pnpm start` | production build / serve |
| `pnpm test` | vitest — engine golden tests, no-lookahead proof, cache tests (PGlite) |
| `pnpm db:generate` | new migration from `src/server/db/schema.ts` |
| `pnpm db:migrate` / `pnpm db:seed` | apply migrations / seed assets |
| `pnpm eval:strategygen` | live NL→DSL eval (needs `ANTHROPIC_API_KEY`) |

## Contributing / workflow

Every task is built in its own git worktree on a `feat/…` or `bugfix/…` branch,
tested end-to-end, then pushed for review — `main` is merged only by the
maintainer. Details and repo conventions live in [`CLAUDE.md`](CLAUDE.md).

## Architecture

- All API keys and integrations live server-side under `src/server/`; the client
  only renders and (later) signs. Keys are validated in `src/server/env.ts`.
- OHLCV: Binance is primary for majors (free, deep history); CoinGecko covers
  long-tail daily. Closed candles are cached forever in Postgres; only missing
  spans are fetched (`src/server/market/candleCache.ts`).
- Strategies are a constrained JSON DSL (`src/server/engine/types.ts`) —
  validated data, never executable code. The engine
  (`src/server/engine/backtest.ts`) is a pure deterministic function: a signal
  on closed bar *i* fills at `open[i+1]`, stops are intrabar, costs apply on both
  sides.
- AI generation (`src/server/ai/strategyGen.ts`) turns natural language into that
  DSL and validates it before anything runs.
