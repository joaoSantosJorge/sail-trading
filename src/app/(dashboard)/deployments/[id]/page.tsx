import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { DeploymentControls } from "@/components/deployments/deployment-controls";
import { GoLiveFlow } from "@/components/deployments/go-live-flow";
import { requireUserPage } from "@/server/auth/guards";
import { db } from "@/server/db";
import { assets, strategies } from "@/server/db/schema";
import { listEvents } from "@/server/deployments/events";
import { getDeployment, PAPER_STARTING_EQUITY_USD } from "@/server/deployments/service";

export const dynamic = "force-dynamic";

const EVENT_LABELS: Record<string, string> = {
  created: "Deployment created",
  activated: "Activated",
  paused: "Paused",
  resumed: "Resumed",
  stopped: "Stopped",
  error: "Error",
  evaluated: "Evaluated bar",
  skipped_bars: "Missed bars skipped",
  paper_entry: "Paper entry",
  paper_exit: "Paper exit",
  kill_switch: "Kill switch tripped",
  went_live: "Switched to live",
  entry_submitted: "Entry submitted",
  entry_filled: "Entry filled",
  exit_submitted: "Exit submitted",
  exit_filled: "Exit filled",
  stop_filled: "Stop-loss filled",
  tp_filled: "Take-profit filled",
  reconcile_adopt: "Position closed externally",
  reconcile_pause: "Paused: unexpected venue position",
};

export default async function DeploymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { userId } = await requireUserPage();
  const { id } = await params;
  const deployment = await getDeployment(userId, Number(id));
  if (!deployment) notFound();

  const [strategy] = await db
    .select({ id: strategies.id, name: strategies.name })
    .from(strategies)
    .where(eq(strategies.id, deployment.strategyId));
  const [asset] = await db
    .select({ symbol: assets.symbol })
    .from(assets)
    .where(eq(assets.id, deployment.assetId));
  const events = await listEvents(userId, deployment.id, { limit: 100 });

  const equity = (deployment.baselineEquityUsd ?? PAPER_STARTING_EQUITY_USD) + deployment.realizedPnlUsd;
  const inPosition = (deployment.positionSize ?? 0) !== 0;

  return (
    <main className="flex w-full flex-col gap-6 p-6">
      <div className="flex items-start justify-between">
        <div>
          <Link href="/deployments" className="text-sm text-muted-foreground hover:underline">
            ← bots
          </Link>
          <h1 className="text-2xl font-semibold">
            {strategy?.name ?? `Strategy #${deployment.strategyId}`} · {asset?.symbol}
          </h1>
          <p className="text-sm text-muted-foreground">
            {deployment.mode} · {deployment.status}
            {deployment.statusReason ? ` (${deployment.statusReason})` : ""} · {deployment.interval} ·{" "}
            {deployment.leverage}x
          </p>
        </div>
        <DeploymentControls id={deployment.id} status={deployment.status} />
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Equity (paper)</p>
          <p className="text-lg font-medium">${equity.toFixed(2)}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Realized PnL</p>
          <p
            className={`text-lg font-medium ${
              deployment.realizedPnlUsd >= 0 ? "text-success" : "text-destructive"
            }`}
          >
            {deployment.realizedPnlUsd >= 0 ? "+" : ""}
            {deployment.realizedPnlUsd.toFixed(2)}
          </p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Position</p>
          <p className="text-lg font-medium">
            {inPosition
              ? `${deployment.positionSize!.toFixed(6)} @ ${deployment.entryPx?.toFixed(2)}`
              : "flat"}
          </p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Sizing</p>
          <p className="text-lg font-medium">
            {deployment.sizingMode === "pct_equity"
              ? `${deployment.sizingValue}% equity`
              : `$${deployment.sizingValue}`}
          </p>
        </div>
      </section>

      {deployment.mode === "paper" && deployment.status === "paused" && (
        <GoLiveFlow deploymentId={deployment.id} />
      )}

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Activity</h2>
        {events.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Nothing yet — activate the bot and events will appear after the next candle closes.
          </p>
        )}
        <ul className="flex flex-col gap-1 text-sm">
          {events.map((e) => {
            const detail = e.detail as Record<string, unknown> | null;
            const signal = e.signal as { entry?: boolean; exit?: boolean } | null;
            return (
              <li key={e.id} className="flex items-baseline gap-2 rounded-md border px-3 py-1.5">
                <span className="whitespace-nowrap text-xs text-muted-foreground">
                  {e.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                </span>
                <span className="font-medium">{EVENT_LABELS[e.type] ?? e.type}</span>
                {e.type === "evaluated" && signal && (
                  <span className="text-xs text-muted-foreground">
                    entry={String(signal.entry)} exit={String(signal.exit)}
                  </span>
                )}
                {(e.type === "paper_entry" || e.type === "paper_exit") && detail && (
                  <span className="text-xs text-muted-foreground">
                    px={Number(detail.px).toFixed(2)}
                    {typeof detail.pnl === "number" &&
                      ` pnl=${detail.pnl >= 0 ? "+" : ""}${detail.pnl.toFixed(2)}`}
                    {typeof detail.reason === "string" && ` (${detail.reason})`}
                  </span>
                )}
                {e.type === "error" && detail && (
                  <span className="text-xs text-destructive">{String(detail.error)}</span>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
