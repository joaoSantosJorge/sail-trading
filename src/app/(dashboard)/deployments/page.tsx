import Link from "next/link";
import { requireUserPage } from "@/server/auth/guards";
import { listDeployments } from "@/server/deployments/service";
import { DeploymentControls } from "@/components/deployments/deployment-controls";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  active: "bg-success/15 text-success",
  paused: "bg-muted text-muted-foreground",
  stopped: "bg-muted text-muted-foreground",
  error: "bg-destructive/15 text-destructive",
};

export default async function DeploymentsPage() {
  const { userId } = await requireUserPage();
  const deployments = await listDeployments(userId);

  return (
    <main className="flex w-full flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Bots</h1>
          <p className="text-sm text-muted-foreground">
            Strategies deployed to run autonomously on every closed candle.
          </p>
        </div>
        <Link
          href="/deployments/new"
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
        >
          Deploy a strategy
        </Link>
      </div>

      <ul className="flex flex-col gap-2">
        {deployments.map((d) => {
          const pnl = d.realizedPnlUsd;
          const inPosition = (d.positionSize ?? 0) !== 0;
          return (
            <li key={d.id} className="flex items-start justify-between rounded-lg border p-4">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Link href={`/deployments/${d.id}`} className="font-medium hover:underline">
                    {d.strategyName} · {d.assetSymbol}
                  </Link>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLES[d.status] ?? ""}`}
                  >
                    {d.status}
                  </span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {d.mode}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {d.interval} · {d.leverage}x ·{" "}
                  {d.sizingMode === "pct_equity" ? `${d.sizingValue}% of equity` : `$${d.sizingValue}`}{" "}
                  per trade · {inPosition ? "in position" : "flat"}
                </p>
                <p className={`text-sm ${pnl >= 0 ? "text-success" : "text-destructive"}`}>
                  PnL {pnl >= 0 ? "+" : ""}
                  {pnl.toFixed(2)} USD
                </p>
              </div>
              <DeploymentControls id={d.id} status={d.status} />
            </li>
          );
        })}
        {deployments.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No bots yet — deploy a backtested strategy to start a paper track record.
          </p>
        )}
      </ul>
    </main>
  );
}
