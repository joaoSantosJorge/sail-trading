import { PortfolioChart } from "@/components/portfolio/portfolio-chart";
import { PortfolioSummary } from "@/components/portfolio/portfolio-summary";
import { WalletsPanel } from "@/components/wallets/wallets-panel";
import { requireUserPage } from "@/server/auth/guards";
import { env } from "@/server/env";
import { getSpotUsd } from "@/server/market/spot";
import { getWalletHistory } from "@/server/portfolio/history";
import { latestSnapshots } from "@/server/portfolio/service";

export const dynamic = "force-dynamic";

export default async function PortfolioPage() {
  const ctx = await requireUserPage();
  const [snapshots, btcUsd] = await Promise.all([
    latestSnapshots(ctx.userId),
    getSpotUsd("bitcoin"),
  ]);
  const wallets = await Promise.all(
    snapshots.map(async (w) => ({
      ...w,
      history: await getWalletHistory(ctx.userId, w.address, { limit: 50 }),
    })),
  );
  const totalUsd = snapshots.reduce((a, w) => a + w.totalUsd, 0);
  const assetCount = new Set(snapshots.flatMap((w) => w.positions.map((p) => p.symbol))).size;

  return (
    <main className="flex w-full flex-col gap-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Portfolio</h1>
        <p className="text-sm text-muted-foreground">
          Your wallets across Ethereum, Base, Arbitrum, Optimism and Polygon — total value in
          USD and BTC, value over time, and full on-chain history plus trades made here. The AI
          reads the latest synced snapshot — it never touches your keys.
        </p>
      </div>
      {wallets.length > 0 && (
        <>
          <PortfolioSummary
            totalUsd={totalUsd}
            btcUsd={btcUsd}
            walletCount={wallets.length}
            assetCount={assetCount}
          />
          <PortfolioChart wallets={snapshots.map(({ address, label }) => ({ address, label }))} />
        </>
      )}
      <WalletsPanel
        wallets={wallets}
        alchemyConfigured={Boolean(env.ALCHEMY_API_KEY)}
        btcUsd={btcUsd}
      />
    </main>
  );
}
