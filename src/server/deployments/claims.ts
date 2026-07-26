import { inArray, sql } from "drizzle-orm";
import { db as defaultDb } from "@/server/db";
import { algoDeployments } from "@/server/db/schema";
import { INTERVALS, prevOpen, type Interval } from "@/server/market/types";
import type { DeploymentsDb, DeploymentRow } from "./service";

/** Give candle sources time to publish a bar before we consider it due. */
export const GRACE_MS = 10_000;
const LEASE_EXPIRY_SQL = "5 minutes";

/**
 * Claim due deployments for a worker: active, unleased (or lease expired),
 * with a closed bar newer than the watermark. FOR UPDATE SKIP LOCKED makes
 * this safe to run from many workers at once — that's the whole sharding
 * story: add capacity by adding processes.
 */
export async function claimDueDeployments(
  workerId: string,
  now: number,
  batch = 25,
  db: DeploymentsDb = defaultDb,
): Promise<DeploymentRow[]> {
  const dueBranches = INTERVALS.map(
    (interval: Interval) =>
      sql`(${algoDeployments.interval} = ${interval} and (${algoDeployments.lastBarT} is null or ${algoDeployments.lastBarT} < ${prevOpen(now - GRACE_MS, interval)}))`,
  ).reduce((a, b) => sql`${a} or ${b}`);

  const claimed = (await db.execute(sql`
    update ${algoDeployments} set claimed_at = now(), claimed_by = ${workerId}
    where id in (
      select id from ${algoDeployments}
      where status = 'active'
        and (claimed_at is null or claimed_at < now() - interval '${sql.raw(LEASE_EXPIRY_SQL)}')
        and (${dueBranches})
      order by last_run_at asc nulls first
      for update skip locked
      limit ${batch}
    )
    returning id
  `)) as { rows: { id: number }[] };
  const ids = claimed.rows.map((r) => Number(r.id));
  if (ids.length === 0) return [];
  return db.select().from(algoDeployments).where(inArray(algoDeployments.id, ids));
}

/** Release one lease (only if this worker still holds it). */
export async function releaseClaim(
  id: number,
  workerId: string,
  db: DeploymentsDb = defaultDb,
): Promise<void> {
  await db
    .update(algoDeployments)
    .set({ claimedAt: null, claimedBy: null })
    .where(sql`${algoDeployments.id} = ${id} and ${algoDeployments.claimedBy} = ${workerId}`);
}

/** Release every lease held by a worker (shutdown path). */
export async function releaseAllClaims(workerId: string, db: DeploymentsDb = defaultDb): Promise<void> {
  await db
    .update(algoDeployments)
    .set({ claimedAt: null, claimedBy: null })
    .where(sql`${algoDeployments.claimedBy} = ${workerId}`);
}
