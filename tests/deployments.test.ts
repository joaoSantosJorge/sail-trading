import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/server/db/schema";
import { claimDueDeployments, releaseClaim } from "@/server/deployments/claims";
import { listEvents, recordEvent } from "@/server/deployments/events";
import {
  createDeployment,
  deleteDeployment,
  getDeployment,
  goLiveDeployment,
  listDeployments,
  PAPER_STARTING_EQUITY_USD,
  transitionDeployment,
  type DeploymentsDb,
} from "@/server/deployments/service";
import { existingBotNotional } from "@/server/deployments/risk";
import { INTERVAL_MS } from "@/server/market/types";
import type { StrategyDSL } from "@/server/engine/types";

const DSL: StrategyDSL = {
  version: 1,
  name: "test cross",
  description: "close above a level",
  interval: "1h",
  indicators: [],
  entry: { op: "gt", left: { kind: "price", field: "close" }, right: { kind: "const", value: 100 } },
  exit: { op: "lt", left: { kind: "price", field: "close" }, right: { kind: "const", value: 90 } },
  risk: { positionSizePct: 10 },
};

let db: DeploymentsDb;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let userId: string;
let otherUserId: string;
let assetId: number;
let cgOnlyAssetId: number;
let strategyId: number;

beforeEach(async () => {
  const pglite = new PGlite();
  testDb = drizzle(pglite, { schema });
  await migrate(testDb, { migrationsFolder: "./drizzle" });
  db = testDb as unknown as DeploymentsDb;

  const [user] = await testDb
    .insert(schema.users)
    .values({ email: "a@test.dev" })
    .returning({ id: schema.users.id });
  userId = user.id;
  const [other] = await testDb
    .insert(schema.users)
    .values({ email: "b@test.dev" })
    .returning({ id: schema.users.id });
  otherUserId = other.id;

  const [eth] = await testDb
    .insert(schema.assets)
    .values({
      coingeckoId: "ethereum",
      symbol: "ETH",
      name: "Ethereum",
      binanceSymbol: "ETHUSDT",
      hyperliquidSymbol: "ETH",
    })
    .returning({ id: schema.assets.id });
  assetId = eth.id;
  const [longTail] = await testDb
    .insert(schema.assets)
    .values({ coingeckoId: "longtail", symbol: "LT", name: "Long Tail" })
    .returning({ id: schema.assets.id });
  cgOnlyAssetId = longTail.id;

  const [strategy] = await testDb
    .insert(schema.strategies)
    .values({ userId, name: DSL.name, dsl: DSL, source: "manual" })
    .returning({ id: schema.strategies.id });
  strategyId = strategy.id;
});

const validInput = () => ({
  strategyId,
  assetId,
  leverage: 2,
  sizingMode: "pct_equity" as const,
  sizingValue: 10,
});

describe("createDeployment", () => {
  it("creates a paused paper deployment with a DSL snapshot", async () => {
    const row = await createDeployment(userId, validInput(), db);
    expect(row.status).toBe("paused");
    expect(row.mode).toBe("paper");
    expect(row.interval).toBe("1h");
    expect(row.dsl).toEqual(DSL);

    // Editing the strategy afterwards must not affect the deployment.
    const events = await listEvents(userId, row.id, {}, db);
    expect(events.map((e) => e.type)).toEqual(["created"]);
  });

  it("rejects someone else's strategy", async () => {
    await expect(createDeployment(otherUserId, validInput(), db)).rejects.toThrow("strategy not found");
  });

  it("rejects intraday strategies on assets without an intraday source", async () => {
    await expect(
      createDeployment(userId, { ...validInput(), assetId: cgOnlyAssetId }, db),
    ).rejects.toThrow(/no intraday candle source/);
  });

  it("rejects out-of-range leverage and sizing", async () => {
    await expect(createDeployment(userId, { ...validInput(), leverage: 99 }, db)).rejects.toThrow(
      /leverage/,
    );
    await expect(createDeployment(userId, { ...validInput(), sizingValue: 0 }, db)).rejects.toThrow(
      /sizingValue/,
    );
    await expect(
      createDeployment(userId, { ...validInput(), sizingMode: "pct_equity", sizingValue: 150 }, db),
    ).rejects.toThrow(/percentage/);
  });

  it("rejects a backtestRunId owned by another user", async () => {
    const [run] = await testDb
      .insert(schema.backtestRuns)
      .values({
        userId: otherUserId,
        strategyId,
        assetId,
        interval: "1h",
        fromT: 0,
        toT: 1,
        params: {},
      })
      .returning({ id: schema.backtestRuns.id });
    await expect(
      createDeployment(userId, { ...validInput(), backtestRunId: run.id }, db),
    ).rejects.toThrow("backtest run not found");
  });
});

describe("transitions", () => {
  it("walks paused → active → paused → stopped and funds paper equity once", async () => {
    const d = await createDeployment(userId, validInput(), db);
    const active = await transitionDeployment(userId, d.id, "active", db);
    expect(active.status).toBe("active");
    expect(active.baselineEquityUsd).toBe(PAPER_STARTING_EQUITY_USD);

    const paused = await transitionDeployment(userId, d.id, "paused", db);
    expect(paused.status).toBe("paused");
    const stopped = await transitionDeployment(userId, d.id, "stopped", db);
    expect(stopped.status).toBe("stopped");

    const events = await listEvents(userId, d.id, {}, db);
    expect(events.map((e) => e.type)).toEqual(["stopped", "paused", "activated", "created"]);
  });

  it("stopped is terminal", async () => {
    const d = await createDeployment(userId, validInput(), db);
    await transitionDeployment(userId, d.id, "stopped", db);
    await expect(transitionDeployment(userId, d.id, "active", db)).rejects.toThrow(/cannot go from/);
  });

  it("is invisible to other users", async () => {
    const d = await createDeployment(userId, validInput(), db);
    expect(await getDeployment(otherUserId, d.id, db)).toBeNull();
    await expect(transitionDeployment(otherUserId, d.id, "active", db)).rejects.toThrow(
      "deployment not found",
    );
    expect(await listDeployments(otherUserId, 50, db)).toHaveLength(0);
  });
});

describe("deleteDeployment", () => {
  it("refuses to delete an active deployment, cascades events otherwise", async () => {
    const d = await createDeployment(userId, validInput(), db);
    await transitionDeployment(userId, d.id, "active", db);
    await expect(deleteDeployment(userId, d.id, db)).rejects.toThrow(/pause or stop/);
    await transitionDeployment(userId, d.id, "paused", db);
    await deleteDeployment(userId, d.id, db);
    expect(await getDeployment(userId, d.id, db)).toBeNull();
    const orphaned = await testDb.select().from(schema.botEvents);
    expect(orphaned).toHaveLength(0);
  });
});

describe("bot_events idempotency", () => {
  it("rejects a second 'evaluated' for the same bar, allows other types", async () => {
    const d = await createDeployment(userId, validInput(), db);
    const barT = 1_700_000_000_000;
    expect(await recordEvent({ deploymentId: d.id, userId, type: "evaluated", barT }, db)).toBe(true);
    expect(await recordEvent({ deploymentId: d.id, userId, type: "evaluated", barT }, db)).toBe(false);
    expect(await recordEvent({ deploymentId: d.id, userId, type: "paper_entry", barT }, db)).toBe(true);
    expect(
      await recordEvent({ deploymentId: d.id, userId, type: "evaluated", barT: barT + 1 }, db),
    ).toBe(true);
  });

  it("paginates the feed with a before-cursor", async () => {
    const d = await createDeployment(userId, validInput(), db);
    for (let i = 0; i < 5; i++) {
      await recordEvent({ deploymentId: d.id, userId, type: "evaluated", barT: i }, db);
    }
    const first = await listEvents(userId, d.id, { limit: 3 }, db);
    expect(first).toHaveLength(3);
    const rest = await listEvents(userId, d.id, { before: first[2].id, limit: 10 }, db);
    expect(rest.length).toBeGreaterThanOrEqual(3); // remaining evaluated + created
    expect(Math.max(...rest.map((e) => e.id))).toBeLessThan(first[2].id);
  });
});

describe("goLiveDeployment", () => {
  const WALLET = "0x2222222222222222222222222222222222222222";

  it("flips a paused paper deployment to live and resets the paper run-state", async () => {
    const d = await createDeployment(userId, validInput(), db);
    // Simulate an existing paper track record.
    await testDb
      .update(schema.algoDeployments)
      .set({ positionSize: 1.5, entryPx: 100, realizedPnlUsd: 42, peakPnlUsd: 50 })
      .where(eq(schema.algoDeployments.id, d.id));

    const live = await goLiveDeployment(userId, d.id, WALLET, 5000, db);
    expect(live.mode).toBe("live");
    expect(live.walletAddress).toBe(WALLET);
    expect(live.baselineEquityUsd).toBe(5000);
    expect(live.positionSize).toBeNull();
    expect(live.realizedPnlUsd).toBe(0);
    expect(live.peakPnlUsd).toBe(0);

    const events = await listEvents(userId, d.id, {}, db);
    expect(events[0].type).toBe("went_live");
  });

  it("refuses while active and when already live", async () => {
    const d = await createDeployment(userId, validInput(), db);
    await transitionDeployment(userId, d.id, "active", db);
    await expect(goLiveDeployment(userId, d.id, WALLET, 5000, db)).rejects.toThrow(/pause/);
    await transitionDeployment(userId, d.id, "paused", db);

    await goLiveDeployment(userId, d.id, WALLET, 5000, db);
    await expect(goLiveDeployment(userId, d.id, WALLET, 5000, db)).rejects.toThrow(/already live/);
  });

  it("requires a Hyperliquid market and positive account value", async () => {
    // A 1d strategy may deploy on a CoinGecko-only asset — but that asset
    // cannot go live (no venue market).
    const [daily] = await testDb
      .insert(schema.strategies)
      .values({ userId, name: "1d", dsl: { ...DSL, interval: "1d" }, source: "manual" })
      .returning({ id: schema.strategies.id });
    const noVenue = await createDeployment(
      userId,
      { ...validInput(), strategyId: daily.id, assetId: cgOnlyAssetId },
      db,
    );
    await expect(goLiveDeployment(userId, noVenue.id, WALLET, 5000, db)).rejects.toThrow(
      /no Hyperliquid market/,
    );

    const onVenue = await createDeployment(userId, validInput(), db);
    await expect(goLiveDeployment(userId, onVenue.id, WALLET, 0, db)).rejects.toThrow(
      /account value/,
    );
  });
});

describe("existingBotNotional", () => {
  it("sums |position × entry| across OTHER active live bots only", async () => {
    // Distinct asset per live bot — the partial unique index (rightly)
    // forbids two active live bots on one coin for the same user.
    let coinN = 0;
    const mk = async (over: Record<string, unknown>) => {
      const [asset] = await testDb
        .insert(schema.assets)
        .values({
          coingeckoId: `coin-${++coinN}`,
          symbol: `C${coinN}`,
          name: `Coin ${coinN}`,
          binanceSymbol: `C${coinN}USDT`,
          hyperliquidSymbol: `C${coinN}`,
        })
        .returning({ id: schema.assets.id });
      const d = await createDeployment(userId, { ...validInput(), assetId: asset.id }, db);
      if (Object.keys(over).length > 0) {
        await testDb
          .update(schema.algoDeployments)
          .set(over)
          .where(eq(schema.algoDeployments.id, d.id));
      }
      return d.id;
    };
    const target = await mk({});
    await mk({ mode: "live", status: "active", positionSize: 2, entryPx: 100 }); // 200
    await mk({ mode: "live", status: "active", positionSize: -1, entryPx: 300 }); // 300
    await mk({ mode: "live", status: "paused", positionSize: 5, entryPx: 100 }); // ignored
    await mk({ mode: "paper", status: "active", positionSize: 5, entryPx: 100 }); // ignored
    expect(await existingBotNotional(userId, target, db)).toBe(500);
  });
});

describe("claimDueDeployments", () => {
  const HOUR = INTERVAL_MS["1h"];

  it("claims only active deployments with a new closed bar past the watermark", async () => {
    const now = Date.now();
    const activeDue = await createDeployment(userId, validInput(), db);
    await transitionDeployment(userId, activeDue.id, "active", db);

    const pausedDue = await createDeployment(userId, validInput(), db);

    const activeFresh = await createDeployment(userId, validInput(), db);
    await transitionDeployment(userId, activeFresh.id, "active", db);
    // Watermark = the latest closed bar (grace included) → not due.
    const latestClosed = Math.floor((now - 10_000) / HOUR) * HOUR - HOUR;
    await testDb
      .update(schema.algoDeployments)
      .set({ lastBarT: latestClosed })
      .where(eq(schema.algoDeployments.id, activeFresh.id));

    const claimed = await claimDueDeployments("w1", now, 25, db);
    const ids = claimed.map((c) => c.id);
    expect(ids).toContain(activeDue.id);
    expect(ids).not.toContain(pausedDue.id);
    expect(ids).not.toContain(activeFresh.id);
  });

  it("does not double-claim under an unexpired lease, reclaims after release", async () => {
    const now = Date.now();
    const d = await createDeployment(userId, validInput(), db);
    await transitionDeployment(userId, d.id, "active", db);

    const first = await claimDueDeployments("w1", now, 25, db);
    expect(first.map((c) => c.id)).toContain(d.id);
    const second = await claimDueDeployments("w2", now, 25, db);
    expect(second.map((c) => c.id)).not.toContain(d.id);

    await releaseClaim(d.id, "w1", db);
    const third = await claimDueDeployments("w2", now, 25, db);
    expect(third.map((c) => c.id)).toContain(d.id);
  });
});
