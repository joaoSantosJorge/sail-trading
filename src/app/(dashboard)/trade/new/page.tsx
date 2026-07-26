import Link from "next/link";
import { NewTradeForm } from "@/components/trade/new-trade-form";
import { requireUserPage } from "@/server/auth/guards";
import { latestSnapshots } from "@/server/portfolio/service";
import { fetchPerpMarkets } from "@/server/trade/perpProposals";
import { CHAIN_NAMES, KNOWN_TOKENS } from "@/server/uniswap/routers";

export const dynamic = "force-dynamic";

/**
 * Manual trade entry. Options (wallets, held tokens, perp markets with mark
 * prices) are page-load props; the server re-validates against live prices
 * and the latest snapshot when the form submits.
 */
export default async function NewTradePage() {
  const ctx = await requireUserPage();
  const snapshots = await latestSnapshots(ctx.userId);

  let markets: { coin: string; szDecimals: number; maxLeverage: number; markPx: number }[] = [];
  try {
    markets = (await fetchPerpMarkets()).filter((m) => m.markPx > 0);
  } catch {
    // Hyperliquid unreachable — the perp tab will say so; swaps still work.
  }

  const perpWallets = snapshots
    .filter((s) => s.chain === "hyperliquid")
    .map((s) => ({ address: s.address, label: s.label }));

  const swapWallets = snapshots
    .filter((s) => s.chain !== "hyperliquid")
    .map((s) => ({
      address: s.address,
      label: s.label,
      positions: s.positions
        .filter((p) => KNOWN_TOKENS[p.chainId] !== undefined)
        .map((p) => ({
          chainId: p.chainId,
          symbol: p.symbol,
          tokenAddress: p.tokenAddress,
          balance: p.balance,
          priceUsd: p.priceUsd,
        })),
    }));

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <div>
        <Link href="/trade" className="text-sm text-muted-foreground hover:underline">
          ← trade
        </Link>
        <h1 className="text-2xl font-semibold">New trade</h1>
        <p className="text-sm text-muted-foreground">
          Create a proposal manually. It goes through the same server-side checks and caps as AI
          proposals, then you review and sign it from your own wallet.
        </p>
      </div>
      <NewTradeForm
        perpWallets={perpWallets}
        markets={markets}
        maxLeverage={Number(process.env.MAX_PERP_LEVERAGE) || 5}
        swapWallets={swapWallets}
        chains={Object.entries(CHAIN_NAMES).map(([id, name]) => ({ chainId: Number(id), name }))}
        knownTokens={Object.fromEntries(
          Object.entries(KNOWN_TOKENS).map(([id, list]) => [id, list.map((t) => t.symbol)]),
        )}
      />
    </main>
  );
}
