import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { DeployForm } from "@/components/deployments/deploy-form";
import { requireUserPage } from "@/server/auth/guards";
import { db } from "@/server/db";
import { assets, strategies } from "@/server/db/schema";
import type { StrategyDSL } from "@/server/engine/types";
import { hasIntradaySource } from "@/server/market/candleCache";

export const dynamic = "force-dynamic";

export default async function NewDeploymentPage({
  searchParams,
}: {
  searchParams: Promise<{ strategyId?: string }>;
}) {
  const { userId } = await requireUserPage();
  const { strategyId } = await searchParams;

  const strategyRows = await db
    .select()
    .from(strategies)
    .where(eq(strategies.userId, userId))
    .orderBy(desc(strategies.createdAt));
  const assetRows = await db.select().from(assets).orderBy(assets.id);

  const strategyOptions = strategyRows.map((s) => ({
    id: s.id,
    name: s.name,
    interval: (s.dsl as StrategyDSL).interval,
  }));
  const assetOptions = assetRows.map((a) => ({
    id: a.id,
    symbol: a.symbol,
    name: a.name,
    intraday: hasIntradaySource(a),
  }));

  return (
    <main className="flex w-full flex-col gap-6 p-6">
      <div>
        <Link href="/deployments" className="text-sm text-muted-foreground hover:underline">
          ← bots
        </Link>
        <h1 className="text-2xl font-semibold">Deploy a strategy</h1>
        <p className="text-sm text-muted-foreground">
          Turn a backtested strategy into a bot that evaluates every closed candle.
        </p>
      </div>
      {strategyOptions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          You have no strategies yet —{" "}
          <Link href="/strategies/new" className="underline">
            create one
          </Link>{" "}
          and backtest it first.
        </p>
      ) : (
        <DeployForm
          strategies={strategyOptions}
          assets={assetOptions}
          initialStrategyId={strategyId ? Number(strategyId) : undefined}
        />
      )}
    </main>
  );
}
