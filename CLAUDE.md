# CLAUDE.md

Guidance for Claude Code working in this repository.

## Project

Sail Trading — an AI research and trading platform for crypto, built
around a persistent AI chat (docked right, server-persisted history) that
operates on the user's assets, strategies, and backtests. Sections: Connect
Wallets, Analyse Assets, Market News, Documents, Trade. **The app never holds
keys or funds.** Design docs: `docs/PLAN.md` (original milestones),
`docs/assistant.md` (chat architecture — read it before touching chat code).

## Mandatory workflow — one worktree + branch per task

Every task (feature or fix) is done in its **own git worktree on its own
branch**, never directly on `main`. The user reviews and authorizes every merge
— **do not merge to `main` yourself.**

1. **Branch + worktree.** Create the branch and an isolated worktree from the
   latest `main`:
   ```bash
   git worktree add -b feat/<short-slug> ../sail-<short-slug> main     # new feature
   git worktree add -b bugfix/<short-slug> ../sail-<short-slug> main   # bug fix
   ```
   Branch prefixes: `feat/` for features, `bugfix/` for fixes. Work inside the
   new worktree directory.
2. **Do the work** in that worktree.
3. **Test the functionality** — not just `pnpm test`, but drive the affected
   flow end-to-end (run the app, hit the route, screenshot the page). See
   "Verifying a change" below.
4. **Correct any error** the tests or manual verification surface. Re-verify.
5. **Commit** with a clear message on the task branch.
6. **Push** the branch to `origin` (`git push -u origin <branch>`).
7. **Stop.** The user reviews the branch/PR and authorizes the merge. Do not
   merge, and do not push to `main`.
8. After merge, remove the worktree: `git worktree remove ../sail-<short-slug>`.
9. **Apply pending DB migrations.** Whenever a task or merge brings Drizzle
   migrations that aren't applied yet, run `pnpm db:migrate` against the
   active `DATABASE_URL` (idempotent — applies only pending ones). Check
   first: compare `ls drizzle/*.sql` against
   `select count(*) from drizzle.__drizzle_migrations`. Watch out: worktrees
   can carry their own `.env.local` — the worktree may migrate the local
   podman DB while the main checkout's default `DATABASE_URL` is the remote
   (Railway) DB, which then still needs `pnpm db:migrate` after merge.

Keep secrets out of commits — `.env.local` is gitignored; only `.env.example`
is tracked.

## Commands

| command | what |
|---|---|
| `pnpm dev` | dev server on http://localhost:3000 |
| `pnpm build` | production build (type-checks + bundles) |
| `pnpm test` | vitest — engine golden tests, no-lookahead proof, cache tests on PGlite |
| `pnpm exec tsc --noEmit` | typecheck |
| `pnpm exec eslint src tests --max-warnings=0` | lint |
| `pnpm db:generate` | new Drizzle migration from `src/server/db/schema.ts` |
| `pnpm db:migrate` / `pnpm db:seed` | apply migrations / seed ~20 assets |
| `pnpm eval:strategygen` | live NL→DSL eval (needs `ANTHROPIC_API_KEY`, costs a few cents) |

Local Postgres runs in a podman container named `sail-postgres` (this machine
has podman, not docker). After a reboot: `podman start sail-postgres`. See README
for first-time setup.

## Verifying a change

Prefer driving the real app over trusting tests alone:
- **API route**: `curl` it and read the JSON body.
- **Page**: screenshot with headless Chrome via playwright-core
  (`executablePath: "/usr/bin/google-chrome"`, `--no-sandbox`), then look at the
  image. A blank frame is a failed render — check `console --errors`.
- **Engine/DSL**: `pnpm test` (deterministic) plus a real backtest via the API.
- **AI generation**: `pnpm eval:strategygen`.

## Architecture

Single Next.js 15 App Router + TypeScript repo. Auth is NextAuth v5 (JWT,
Credentials + optional Google) with per-user data scoping; `requireUserPage()` /
`requireUserApi()` guards from `src/server/auth/guards.ts`. Middleware uses the
edge-safe `src/server/auth/config.ts` ONLY (never import the full auth config —
the pg driver cannot load in the edge runtime) and bypasses the chat stream
route. API convention: REST under `/api/v1/*`, thin routes → service functions,
zod safeParse → 400, guard returns `NextResponse | ctx`.

- **Client** (`src/app`, `src/components`) — shadcn "base-nova" on
  `@base-ui/react`,
  Tailwind v4 CSS-config (OKLCH tokens in globals.css), lucide icons,
  next-themes. RSC-first: server components fetch, client leaves mutate via
  `fetch('/api/v1/...')` + `router.refresh()`. No react-query for app data.
- **Server** (`src/server`) — all integrations, the backtest engine, chat
  persistence, DB access. All keys server-only via Zod-validated `env.ts`.
- **Data** — Postgres via Drizzle (`src/server/db`). Market data (assets,
  candles) is global; everything else carries `user_id`.

Key modules:
- `src/app/api/v1/chat/stream/route.ts` + `src/server/chat/{service,turns}.ts`
  + `src/server/ai/tools/*` — the AI chat (see `docs/assistant.md`).
- `src/components/assistant/` — dock (resizable right panel, single mounted
  instance), thread view, approval cards, render blocks.
- `src/server/engine/types.ts` — the strategy JSON DSL (Zod + semantic
  validation). The contract between AI, engine, DB, and UI.
- `src/server/engine/backtest.ts` — deterministic simulation: signals on closed
  bar *i* fill at `open[i+1]` (no lookahead), intrabar stops, fees/slippage/gas.
- `src/server/backtests/run.ts` — ownership-checked execution service shared by
  the REST route and the chat tool.
- `src/server/market/candleCache.ts` — fetch-through OHLCV cache; only missing
  spans are fetched (Binance for majors, CoinGecko for long-tail).
- `src/server/ai/prompts.ts` — STABLE_SYSTEM + shared STRATEGY_DSL_SPEC (one
  spec for chat and the standalone generator — keep byte-stable for the prompt
  cache).

## Invariants — do not break these

- **The AI produces data, never code.** Strategies are a validated JSON DSL;
  trade proposals are validated JSON. Everything AI-produced passes Zod +
  server-side clamping before it touches the engine or a transaction.
- **The backtest engine is a pure deterministic function.** No `Date.now`, no
  randomness. Same inputs → identical output (there's a test for this). Never
  introduce lookahead: a signal on bar *i* may only fill at `open[i+1]` or later.
- **Keys and integrations stay server-side.** Never import `src/server/*` into a
  client component. The client signs; it never sees a secret.
- **The DSL is the source of truth for strategies.** Add indicators/operators by
  extending `engine/types.ts` (schema + semantic checks) and the interpreter
  together — `STRATEGY_DSL_SPEC` in `ai/prompts.ts` documents the same spec,
  keep them in sync.
- **Chat history is server-authoritative.** The client's copy is never trusted:
  every turn rebuilds history from the DB, and approval responses are merged
  only into genuinely pending persisted parts. Writes from chat are
  approval-gated (`needsApproval`) — never remove that gate.
- **The chat stream route must stay excluded from middleware** (buffering
  breaks streaming) and must authenticate itself.

## Phases

All three redesign phases are done: A (`feat/app-shell-chat`: auth + shell +
chat), B (`feat/sections`: wallets/Alchemy, asset view, CryptoPanic news
cache, Documents hub, chat memory tools), C (`feat/trade`: propose_trade
action tool + Uniswap execution flow). Notable pieces: pure indicator math in
`src/lib/indicators` (engine re-exports); news cache mirrors the candle-cache
TTL pattern (PGlite-tested); web3 stack scoped to
`src/components/web3/web3-provider.tsx`; `@x402/*` optionals stubbed in
next.config.ts.

Phase C invariants: proposals are clamped by the PURE `clampProposal`
(`src/server/trade/proposals.ts`, unit-tested) — never bypass it; /swap only
accepts server-minted quoteIds (30s TTL, single use); every swap target is
checked against the hardcoded allowlist in `src/server/uniswap/routers.ts`;
executions are marked confirmed only after server-side receipt verification;
the chat is never told execution outcomes (get_execution is the only path).
The Uniswap API integration is LIVE-VERIFIED (2026-07-22, real key): quote
and swap request/response shapes, native-ETH (no permit) path, ERC-20
permitData `{domain,types,values}` + `PermitSingle`, check_approval shape,
and the router allowlist matched the real UniversalRouter v2 on Base. The
quote route additionally verifies approval calldata grants allowance to
Permit2 only. The only untested hop is the wallet signature + broadcast
(requires the user's funded wallet).
