import { and, desc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { db as defaultDb } from "@/server/db";
import { algoDeployments, assets, backtestRuns, strategies } from "@/server/db/schema";
import { StrategyDSLSchema, type StrategyDSL } from "@/server/engine/types";
import { hasIntradaySource } from "@/server/market/candleCache";
import { recordEvent } from "./events";

/** Structural db type so tests can pass a PGlite drizzle instance. */
export type DeploymentsDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export class DeploymentError extends Error {}

/** Paper accounts start with the same equity the backtest engine defaults to. */
export const PAPER_STARTING_EQUITY_USD = 10_000;

function maxLeverageCap(): number {
  return Number(process.env.MAX_PERP_LEVERAGE) || 5;
}

export type CreateDeploymentInput = {
  strategyId: number;
  assetId: number;
  backtestRunId?: number;
  leverage: number;
  sizingMode: "pct_equity" | "fixed_usd";
  sizingValue: number;
  maxDrawdownPct?: number;
  dailyLossLimitUsd?: number;
};

export type DeploymentRow = typeof algoDeployments.$inferSelect;

/** Status transitions a user may request. Stopped is terminal by design —
 * a stopped bot's history stays frozen; deploy a duplicate to run it again. */
const TRANSITIONS: Record<string, string[]> = {
  paused: ["active", "stopped"],
  active: ["paused", "stopped"],
  error: ["active", "stopped"], // resume after the user resolves the cause
};

/**
 * Create a deployment from a user's strategy. M1: always paper mode, created
 * paused. The DSL is SNAPSHOTTED — later strategy edits never touch a
 * running bot.
 */
export async function createDeployment(
  userId: string,
  input: CreateDeploymentInput,
  db: DeploymentsDb = defaultDb,
): Promise<DeploymentRow> {
  const [strategy] = await db
    .select()
    .from(strategies)
    .where(and(eq(strategies.id, input.strategyId), eq(strategies.userId, userId)));
  if (!strategy) throw new DeploymentError("strategy not found");
  const [asset] = await db.select().from(assets).where(eq(assets.id, input.assetId));
  if (!asset) throw new DeploymentError("asset not found");

  const dsl = StrategyDSLSchema.parse(strategy.dsl) as StrategyDSL;
  if (dsl.interval !== "1d" && !hasIntradaySource(asset)) {
    throw new DeploymentError(
      `${asset.symbol} has no intraday candle source — this ${dsl.interval} strategy cannot run on it`,
    );
  }

  const leverageCap = maxLeverageCap();
  if (!Number.isInteger(input.leverage) || input.leverage < 1 || input.leverage > leverageCap) {
    throw new DeploymentError(`leverage must be an integer between 1 and ${leverageCap}`);
  }
  if (input.sizingMode === "pct_equity") {
    if (!(input.sizingValue > 0 && input.sizingValue <= 100)) {
      throw new DeploymentError("sizingValue must be a percentage in (0, 100]");
    }
  } else if (!(input.sizingValue > 0)) {
    throw new DeploymentError("sizingValue must be a positive USD amount");
  }
  if (input.maxDrawdownPct !== undefined && !(input.maxDrawdownPct > 0 && input.maxDrawdownPct <= 100)) {
    throw new DeploymentError("maxDrawdownPct must be in (0, 100]");
  }
  if (input.dailyLossLimitUsd !== undefined && !(input.dailyLossLimitUsd > 0)) {
    throw new DeploymentError("dailyLossLimitUsd must be positive");
  }
  if (input.backtestRunId !== undefined) {
    const [run] = await db
      .select({ id: backtestRuns.id })
      .from(backtestRuns)
      .where(and(eq(backtestRuns.id, input.backtestRunId), eq(backtestRuns.userId, userId)));
    if (!run) throw new DeploymentError("backtest run not found");
  }

  const [row] = await db
    .insert(algoDeployments)
    .values({
      userId,
      strategyId: strategy.id,
      backtestRunId: input.backtestRunId,
      assetId: asset.id,
      dsl,
      interval: dsl.interval,
      mode: "paper",
      status: "paused",
      leverage: input.leverage,
      sizingMode: input.sizingMode,
      sizingValue: input.sizingValue,
      maxDrawdownPct: input.maxDrawdownPct,
      dailyLossLimitUsd: input.dailyLossLimitUsd,
    })
    .returning();
  await recordEvent({ deploymentId: row.id, userId, type: "created" }, db);
  return row;
}

export async function getDeployment(
  userId: string,
  id: number,
  db: DeploymentsDb = defaultDb,
): Promise<DeploymentRow | null> {
  const [row] = await db
    .select()
    .from(algoDeployments)
    .where(and(eq(algoDeployments.id, id), eq(algoDeployments.userId, userId)));
  return row ?? null;
}

export type DeploymentListItem = DeploymentRow & {
  strategyName: string;
  assetSymbol: string;
};

export async function listDeployments(
  userId: string,
  limit = 50,
  db: DeploymentsDb = defaultDb,
): Promise<DeploymentListItem[]> {
  const rows = await db
    .select({
      deployment: algoDeployments,
      strategyName: strategies.name,
      assetSymbol: assets.symbol,
    })
    .from(algoDeployments)
    .innerJoin(strategies, eq(algoDeployments.strategyId, strategies.id))
    .innerJoin(assets, eq(algoDeployments.assetId, assets.id))
    .where(eq(algoDeployments.userId, userId))
    .orderBy(desc(algoDeployments.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r.deployment, strategyName: r.strategyName, assetSymbol: r.assetSymbol }));
}

/** Apply a user-requested status change, enforcing the transition machine. */
export async function transitionDeployment(
  userId: string,
  id: number,
  next: "active" | "paused" | "stopped",
  db: DeploymentsDb = defaultDb,
): Promise<DeploymentRow> {
  const row = await getDeployment(userId, id, db);
  if (!row) throw new DeploymentError("deployment not found");
  if (!(TRANSITIONS[row.status] ?? []).includes(next)) {
    throw new DeploymentError(`cannot go from "${row.status}" to "${next}"`);
  }

  const patch: Partial<typeof algoDeployments.$inferInsert> = {
    status: next,
    statusReason: null,
    updatedAt: new Date(),
  };
  if (next === "active") {
    patch.consecutiveErrors = 0;
    // First activation of a paper bot funds its simulated account.
    if (row.mode === "paper" && row.baselineEquityUsd === null) {
      patch.baselineEquityUsd = PAPER_STARTING_EQUITY_USD;
    }
  }
  const [updated] = await db
    .update(algoDeployments)
    .set(patch)
    .where(and(eq(algoDeployments.id, id), eq(algoDeployments.userId, userId)))
    .returning();
  const type = next === "active" ? (row.status === "error" ? "resumed" : "activated") : next;
  await recordEvent({ deploymentId: id, userId, type }, db);
  return updated;
}

/**
 * Flip a PAUSED paper deployment to live. Requirements: asset trades on
 * Hyperliquid, the user's enclave agent is venue-approved for the wallet,
 * and the wallet has account value. Paper run-state (position, PnL) is
 * RESET — a live track record never blends with a simulated one.
 */
export async function goLiveDeployment(
  userId: string,
  id: number,
  walletAddress: string,
  accountValueUsd: number,
  db: DeploymentsDb = defaultDb,
): Promise<DeploymentRow> {
  const row = await getDeployment(userId, id, db);
  if (!row) throw new DeploymentError("deployment not found");
  if (row.status !== "paused") throw new DeploymentError("pause the deployment before going live");
  if (row.mode === "live") throw new DeploymentError("deployment is already live");
  const [asset] = await db.select().from(assets).where(eq(assets.id, row.assetId));
  if (!asset?.hyperliquidSymbol) {
    throw new DeploymentError(`${asset?.symbol ?? "asset"} has no Hyperliquid market`);
  }
  if (!(accountValueUsd > 0)) {
    throw new DeploymentError("wallet has no perps account value on Hyperliquid");
  }

  const [updated] = await db
    .update(algoDeployments)
    .set({
      mode: "live",
      walletAddress: walletAddress.toLowerCase(),
      baselineEquityUsd: accountValueUsd,
      positionSize: null,
      entryPx: null,
      entryBarT: null,
      entryOid: null,
      tpOid: null,
      slOid: null,
      cooldownLeft: 0,
      realizedPnlUsd: 0,
      peakPnlUsd: 0,
      statusReason: null,
      updatedAt: new Date(),
    })
    .where(and(eq(algoDeployments.id, id), eq(algoDeployments.userId, userId)))
    .returning();
  await recordEvent(
    {
      deploymentId: id,
      userId,
      type: "went_live",
      detail: { walletAddress: walletAddress.toLowerCase(), baselineEquityUsd: accountValueUsd },
    },
    db,
  );
  return updated;
}

/** Delete a deployment and its events. Refused while the bot is running. */
export async function deleteDeployment(
  userId: string,
  id: number,
  db: DeploymentsDb = defaultDb,
): Promise<void> {
  const row = await getDeployment(userId, id, db);
  if (!row) throw new DeploymentError("deployment not found");
  if (row.status === "active") throw new DeploymentError("pause or stop the deployment first");
  await db
    .delete(algoDeployments)
    .where(and(eq(algoDeployments.id, id), eq(algoDeployments.userId, userId)));
}
