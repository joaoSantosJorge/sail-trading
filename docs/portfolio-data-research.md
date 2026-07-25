# Portfolio data source — research & decision (2026-07-23)

Question: what should power the wallet portfolio view (multi-chain balances +
USD/BTC values + transaction history)? Options researched: portfolio APIs,
node-provider RPC + own indexer, fully self-hosted nodes, open-source hybrids.

## Decision

**Alchemy now, behind a chain-adapter interface; Zerion later if needed.**

- Alchemy (key already configured, free 30M CU/month) covers EVM×5 balances +
  USD prices in one Portfolio API call and transfer history via
  `alchemy_getAssetTransfers`. Cost at current scale: $0.
- Every data source is wrapped in a `ChainAdapter`
  (`src/server/portfolio/adapters/`) so a provider swap or a new chain is a
  new adapter, not a rewrite.
- Upgrade trigger → **Zerion API** (free 2K req/day → $149/mo, 250K req):
  when we want uniform *decoded* history + DeFi positions across EVM +
  Solana + HyperEVM in one schema.
- Keyless gap-fillers when those chains land: Hyperliquid `api.hyperliquid.xyz/info`
  (free), mempool.space or self-hosted electrs for Bitcoin, Sui RPC for balances.

## Portfolio APIs compared (pricing verified July 2026)

| Provider | EVM 5 | Solana | BTC | Sui | HyperEVM | Free tier | First paid |
|---|---|---|---|---|---|---|---|
| Zerion | ✅ | ✅ | ❌ | ❌ | ✅ | 2K req/day | $149/mo |
| Alchemy | ✅ | ✅ balances | ❌ | ❌ | ❌ | 30M CU/mo | $0.45/1M CU |
| Moralis | ✅ | ✅ | early access | ❌ | ✅ | 40K CU/day | $49/mo |
| GoldRush (Covalent) | ✅ | partial | **✅ only GA** | ❌ | ✅ | trial only | $10/mo |
| DeBank Cloud | ✅ | ❌ | ❌ | ❌ | ? | none (prepaid units) | ~$200/1M units* |
| Dune SIM | — | — | — | — | — | **sunset 2026-08-01** | — |

*unverified. No general portfolio API covers Sui.

Alchemy caveats: decoded tx-history endpoint is beta (ETH+Base only) → we use
`getAssetTransfers` (raw transfers, no USD values) everywhere instead; Solana
history needs raw RPC.

## The no-API routes (why we didn't take them)

Plain JSON-RPC has no "list this wallet's tokens/transactions" method — token
discovery means scanning all `Transfer` logs per chain, native history needs
tracing archive nodes.

| Route | $/month | Build | Ops | Verdict |
|---|---|---|---|---|
| Provider RPC + own indexer | $0–50 | 6–10 person-wk | low-mod | viable, but Alchemy's enhanced APIs make it moot |
| Self-hosted nodes + indexer | $300–1,500+ | 10–16+ wk | high | Solana history effectively out of reach; not justified <1k users |
| TrueBlocks + electrs hybrid | $30–100 | 6–12 wk | moderate | ETH-mainnet+BTC only; AGPL/GPL questions |

The one genuinely cheap self-host is **Bitcoin** (bitcoind + electrs,
~$20–40/mo VPS, complete address history) — noted for the future BTC adapter.

## Current implementation (this branch)

- Balances: Alchemy Portfolio API, networks `eth/base/arb/opt/polygon-mainnet`
  (`src/server/portfolio/alchemy.ts`).
- History: `alchemy_getAssetTransfers` per network, both directions, page-capped
  with per-(wallet, network) block watermarks (`alchemyTransfers.ts`,
  `transferCache.ts`), cached in `wallet_transfers`, merged with the app's own
  `executions` (`history.ts`).
- BTC values: derived at read time — `valueUsd / btcUsd` with the BTC/USD spot
  from CoinGecko (`src/server/market/spot.ts`); never stored.
- Known gaps: transfer rows carry no historical USD value (column reserved);
  `internal` (traced) transfers only on ETH/Polygon; spam filtering is
  heuristic (raw payloads kept for refinement).
