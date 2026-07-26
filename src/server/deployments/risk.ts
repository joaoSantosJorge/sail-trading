import { and, eq, ne } from "drizzle-orm";
import { db as defaultDb } from "@/server/db";
import { algoDeployments } from "@/server/db/schema";
import type { DeploymentsDb } from "./service";

/**
 * Aggregate risk accounting across a user's LIVE deployments. The per-order
 * clamp (clampPerpProposal) caps each order in isolation; this closes the
 * gap where many bots individually under the cap could still stack exposure.
 * Pure math + one narrow query, unit-tested on PGlite.
 */

export class RiskError extends Error {}

function maxAccountExposurePct(): number {
  return Number(process.env.MAX_ACCOUNT_EXPOSURE_PCT) || 80;
}

export type ExposureCheckInput = {
  /** Notional the new order would add, USD. */
  newNotionalUsd: number;
  /** Live account value from clearinghouseState, USD. */
  accountValueUsd: number;
  /** Sum of |notional| of positions currently held by live bots, USD. */
  existingBotNotionalUsd: number;
};

/** Throws RiskError when the new order would breach the aggregate cap. */
export function checkAggregateExposure(input: ExposureCheckInput): void {
  const capPct = maxAccountExposurePct();
  const capUsd = (input.accountValueUsd * capPct) / 100;
  const total = input.existingBotNotionalUsd + input.newNotionalUsd;
  if (total > capUsd) {
    throw new RiskError(
      `aggregate bot exposure $${total.toFixed(0)} would exceed ${capPct}% of account value ` +
        `($${capUsd.toFixed(0)}); existing bot notional $${input.existingBotNotionalUsd.toFixed(0)}`,
    );
  }
}

/**
 * Sum of |expected notional| across the user's OTHER active live deployments
 * (positionSize × entryPx of what each bot believes it holds).
 */
export async function existingBotNotional(
  userId: string,
  excludeDeploymentId: number,
  db: DeploymentsDb = defaultDb,
): Promise<number> {
  const rows = await db
    .select({
      positionSize: algoDeployments.positionSize,
      entryPx: algoDeployments.entryPx,
    })
    .from(algoDeployments)
    .where(
      and(
        eq(algoDeployments.userId, userId),
        eq(algoDeployments.mode, "live"),
        eq(algoDeployments.status, "active"),
        ne(algoDeployments.id, excludeDeploymentId),
      ),
    );
  return rows.reduce((sum, r) => {
    if (!r.positionSize || !r.entryPx) return sum;
    return sum + Math.abs(r.positionSize) * r.entryPx;
  }, 0);
}
