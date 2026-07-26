import http from "node:http";
import { sql } from "drizzle-orm";
import { db } from "@/server/db";
import { algoDeployments, assets } from "@/server/db/schema";
import { claimDueDeployments, releaseAllClaims, releaseClaim } from "@/server/deployments/claims";
import { recordEvent } from "@/server/deployments/events";
import type { DeploymentRow } from "@/server/deployments/service";
import { getCandles } from "@/server/market/candleCache";
import type { Interval } from "@/server/market/types";
import { tickDeployment, type TickPatch } from "./tick";

/**
 * The deployments worker: a plain long-running node process (no next/*) that
 * evaluates every active deployment once per closed candle. Run with
 * `pnpm start:worker`. Shard-ready by construction: deployments are claimed
 * via FOR UPDATE SKIP LOCKED under a lease (see claims.ts), so adding
 * capacity later is just running more instances of this process.
 */

const WORKER_ID = process.env.WORKER_ID ?? `worker-${process.pid}`;
const LOOP_MS = 20_000;
const CLAIM_BATCH = 25;
const MAX_CONSECUTIVE_ERRORS = 5;
const TICK_CONCURRENCY = 8;

let running = true;
let inFlight = 0;
let lastTickAt: string | null = null;

function log(msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), worker: WORKER_ID, msg, ...extra }));
}

async function runOne(deployment: DeploymentRow) {
  try {
    const [asset] = await db.select().from(assets).where(sql`${assets.id} = ${deployment.assetId}`);
    if (!asset) throw new Error(`asset ${deployment.assetId} not found`);

    const result = await tickDeployment(deployment, {
      now: () => Date.now(),
      loadCandles: async (d, from, to) =>
        (await getCandles(db, asset, d.interval as Interval, from, to)).candles,
      recordEvent: (event) => recordEvent({ ...event, userId: deployment.userId }),
      updateDeployment: async (id, patch: TickPatch) => {
        await db
          .update(algoDeployments)
          .set({ ...patch, updatedAt: new Date() })
          .where(sql`${algoDeployments.id} = ${id}`);
      },
    });
    if (result.outcome === "evaluated" && result.action !== "none") {
      log("tick action", { deployment: deployment.id, barT: result.barT, action: result.action });
    }
  } catch (err) {
    const message = (err as Error).message;
    log("tick error", { deployment: deployment.id, error: message });
    const errors = deployment.consecutiveErrors + 1;
    const disable = errors >= MAX_CONSECUTIVE_ERRORS;
    await db
      .update(algoDeployments)
      .set({
        consecutiveErrors: errors,
        ...(disable ? { status: "error", statusReason: "errors" } : {}),
        updatedAt: new Date(),
      })
      .where(sql`${algoDeployments.id} = ${deployment.id}`);
    await recordEvent({
      deploymentId: deployment.id,
      userId: deployment.userId,
      type: "error",
      detail: { error: message, consecutiveErrors: errors, disabled: disable },
    }).catch(() => {});
  } finally {
    await releaseClaim(deployment.id, WORKER_ID).catch(() => {});
  }
}

async function loop() {
  while (running) {
    const started = Date.now();
    try {
      const due = await claimDueDeployments(WORKER_ID, started, CLAIM_BATCH);
      if (due.length > 0) log("claimed", { count: due.length });
      // Bounded concurrency without extra deps.
      const queue = [...due];
      const workers = Array.from({ length: Math.min(TICK_CONCURRENCY, queue.length) }, async () => {
        for (let d = queue.shift(); d !== undefined; d = queue.shift()) {
          inFlight += 1;
          try {
            await runOne(d);
          } finally {
            inFlight -= 1;
          }
        }
      });
      await Promise.all(workers);
      lastTickAt = new Date().toISOString();
    } catch (err) {
      log("loop error", { error: (err as Error).message });
    }
    const elapsed = Date.now() - started;
    if (running && elapsed < LOOP_MS) {
      await new Promise((r) => setTimeout(r, LOOP_MS - elapsed));
    }
  }
}

function startHealthServer() {
  const port = Number(process.env.PORT) || 8787;
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: running, worker: WORKER_ID, lastTickAt, inFlight }));
  });
  server.listen(port, () => log("health server listening", { port }));
  return server;
}

async function shutdown(server: http.Server) {
  log("shutting down");
  running = false;
  server.close();
  // Drain in-flight ticks, bounded.
  const deadline = Date.now() + 30_000;
  while (inFlight > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  await releaseAllClaims(WORKER_ID).catch(() => {});
  process.exit(0);
}

const server = startHealthServer();
process.on("SIGTERM", () => void shutdown(server));
process.on("SIGINT", () => void shutdown(server));
log("worker started", { loopMs: LOOP_MS });
void loop();
