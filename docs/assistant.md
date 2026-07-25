# AI Assistant — Design Doc

The chat is the base of the app: a docked right panel (expand/collapse/resize,
mobile overlay) present on every dashboard page, with server-persisted history.
This file records the chat architecture this repo implements.

## Stack

Vercel AI SDK v6 (`ai`, `@ai-sdk/anthropic`) + `@assistant-ui/react` +
`@assistant-ui/react-ai-sdk` + `streamdown`. Model: `claude-sonnet-5`
(`MODELS.chat` in `src/server/ai/client.ts`); titles/summaries on
`claude-haiku-4-5`.

## Request flow

`POST /api/v1/chat/stream` (`src/app/api/v1/chat/stream/route.ts`):

1. `requireUserApi()` → userId. Middleware BYPASSES this route (streaming must
   not be wrapped); it authenticates itself.
2. Normal turn (last message = user): `prepareUITurn` — purge expired threads →
   sanitize parts (text only) → resolve/create thread → insert user row →
   REBUILD history from DB (client history is never trusted).
   Approval resume (last message = assistant with `approval-responded` parts):
   `prepareApprovalResumeTurn` merges only {approvalId, approved, reason} into
   the PERSISTED parts — a client cannot forge approvals.
3. `streamText` with STABLE_SYSTEM (byte-stable → Anthropic prompt cache) +
   tools, `stopWhen: stepCountIs(6)`.
4. `toUIMessageStreamResponse` with `x-thread-id` header (new-thread adoption
   without remount) and `onFinish`: persist assistant row (+ tool audit rows +
   cost cents) → update rolling summary → generate title (first turn only).
   Each in its own try/catch.

No API key → persisted fallback reply streamed as a manual UIMessage stream.

## Tools (`src/server/ai/tools/`)

- **Read** (registry in `read-tools.ts`, bridged by `sdk-tools.ts`, audited,
  errors returned as `{error}`): `list_assets`, `get_market_snapshot`,
  `get_ohlcv_summary`, `list_strategies`, `get_strategy`, `list_backtests`,
  `get_backtest`. All scoped to the session userId.
- **Render** (`render-tools.ts` + client-safe `src/lib/ai/render-schemas.ts`):
  `render_price_chart` and `render_backtest` args are a SPEC/reference — the
  client block fetches candles / the run from `/api/v1` so series data never
  rides through the model; `render_metrics` args are the artifact.
- **Write** (`write-tools.ts`, `needsApproval: true` → ApprovalCard):
  `create_strategy` (model authors the DSL; execute re-runs
  `parseStrategyDSL`; `{error, problems}` → in-loop repair), `run_backtest`
  (same service as the REST route), and `save_research_report` (persists a
  markdown report with the turn's tool-audit trail as provenance). Registered
  on resume turns too — that is when execution happens.
- **Phase B reads**: `get_portfolio` (latest holdings snapshot, staleness
  flagged), `get_market_news` (via the TTL news cache only), and the MEMORY
  pair `search_chat_history` / `get_chat_thread` (actor-scoped, current thread
  excluded).
- **Action tools** (`action-tools.ts`, zero side effects, NO approval gate —
  nothing moves funds): `propose_trade` validates via `clampProposal`
  (snapshot + caps), persists a proposal row (24h expiry), and returns a
  ProposedAction; the client card auto-navigates once to /trade/[id] where the
  wallet signature is the sole authorization. `list_trade_proposals` /
  `get_execution` are the only ways the model learns recorded status — it is
  never told whether a swap happened.

## Persistence (`src/server/chat/`)

`chat_threads` / `chat_messages` (parts jsonb = UIMessage parts; content =
flattened text) / `chat_tool_calls` (server-written audit). Only user+assistant
rows persisted. Retention: 365 days, purged on every turn/list.
`expireStalePendingApprovals` marks unanswered approvals denied at the start of
every turn — without it the rebuilt history is unconvertible.

## Client (`src/components/assistant/`)

`dock/` — DashboardSplit (flex two-pane, draggable separator, `--dock-width`),
cookies `assistant_dock_{thread,collapsed,width}` read server-side in the
layout; single mounted chat instance across in-flow/overlay/collapsed/mobile
states so streams survive. `assistant-dock-panel` prefetches history and
remounts the runtime per thread-switch (session key); x-thread-id adoption
updates state without remount.
`v2/` — runtime provider (AssistantChatTransport), load-only history adapter
(server persists authoritatively), thread-view (part → component mapping;
empty `reasoning` parts from sonnet-5 adaptive thinking render null),
approval-card. `blocks/` — price-chart / metrics / backtest, defensively
re-parsed from persisted parts.

## Known behaviors

- The sidebar thread title updates on the next thread-list refresh after the
  first turn (title generation runs post-stream) — same as tracking.
- Approval cards show "details unavailable" while args are still streaming;
  they render the full rules once the part completes.
