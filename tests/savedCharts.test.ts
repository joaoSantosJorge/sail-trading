import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/server/db/schema";
import {
  createSavedChart,
  deleteSavedChart,
  getSavedChart,
  listSavedCharts,
  MAX_DRAWINGS,
  MAX_SAVED_CHARTS,
  savedChartCreateSchema,
  savedChartPatchSchema,
  updateSavedChart,
  type ChartsDb,
} from "@/server/charts/savedCharts";

let db: ChartsDb;
let userA: string;
let userB: string;
let assetId: number;

const drawing = {
  name: "segment" as const,
  points: [
    { timestamp: 1_700_000_000_000, value: 100 },
    { timestamp: 1_700_100_000_000, value: 110 },
  ],
};

beforeEach(async () => {
  const pglite = new PGlite();
  const testDb = drizzle(pglite, { schema });
  await migrate(testDb, { migrationsFolder: "./drizzle" });
  db = testDb as unknown as ChartsDb;

  const users = await testDb
    .insert(schema.users)
    .values([{ email: "a@test.local" }, { email: "b@test.local" }])
    .returning();
  userA = users[0].id;
  userB = users[1].id;

  const [asset] = await testDb
    .insert(schema.assets)
    .values({ coingeckoId: "ethereum", symbol: "ETH", name: "Ethereum", binanceSymbol: "ETHUSDT" })
    .returning();
  assetId = asset.id;
});

describe("savedCharts service", () => {
  it("creates, lists, gets, updates and deletes a chart", async () => {
    const created = await createSavedChart(db, userA, {
      assetId,
      name: "ETH weekly",
      interval: "1w",
      drawings: [drawing],
      indicators: [{ name: "MA" }, { name: "VOL" }],
    });
    expect(created).not.toBeNull();

    const list = await listSavedCharts(db, userA);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: "ETH weekly",
      symbol: "ETH",
      interval: "1w",
      drawingCount: 1,
      indicatorCount: 2,
      indicatorNames: ["MA", "VOL"],
    });

    const fetched = await getSavedChart(db, userA, created!.id);
    expect(fetched?.drawings).toEqual([drawing]);

    const updated = await updateSavedChart(db, userA, created!.id, {
      interval: "1d",
      drawings: [],
    });
    expect(updated?.interval).toBe("1d");
    expect(updated?.drawings).toEqual([]);
    expect(updated?.name).toBe("ETH weekly"); // untouched fields survive
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(created!.updatedAt.getTime());

    expect(await deleteSavedChart(db, userA, created!.id)).toBe(true);
    expect(await listSavedCharts(db, userA)).toHaveLength(0);
  });

  it("scopes every operation to the owning user", async () => {
    const created = await createSavedChart(db, userA, {
      assetId,
      name: "private",
      interval: "1d",
      drawings: [],
      indicators: [],
    });

    expect(await getSavedChart(db, userB, created!.id)).toBeNull();
    expect(await listSavedCharts(db, userB)).toHaveLength(0);
    expect(await updateSavedChart(db, userB, created!.id, { name: "stolen" })).toBeNull();
    expect(await deleteSavedChart(db, userB, created!.id)).toBe(false);
    // A's chart is untouched by B's attempts.
    expect((await getSavedChart(db, userA, created!.id))?.name).toBe("private");
  });

  it("enforces the saved-charts limit", async () => {
    for (let i = 0; i < MAX_SAVED_CHARTS; i++) {
      const row = await createSavedChart(db, userA, {
        assetId,
        name: `chart ${i}`,
        interval: "1d",
        drawings: [],
        indicators: [],
      });
      expect(row).not.toBeNull();
    }
    const over = await createSavedChart(db, userA, {
      assetId,
      name: "one too many",
      interval: "1d",
      drawings: [],
      indicators: [],
    });
    expect(over).toBeNull();
    // Another user is unaffected by A's limit.
    const b = await createSavedChart(db, userB, {
      assetId,
      name: "b's chart",
      interval: "1d",
      drawings: [],
      indicators: [],
    });
    expect(b).not.toBeNull();
  });
});

describe("savedCharts validation schemas", () => {
  it("rejects unknown overlay/indicator names and bad intervals", () => {
    const base = { assetId: 1, name: "x", interval: "1d", drawings: [], indicators: [] };
    expect(savedChartCreateSchema.safeParse(base).success).toBe(true);
    expect(
      savedChartCreateSchema.safeParse({ ...base, interval: "3h" }).success,
    ).toBe(false);
    expect(
      savedChartCreateSchema.safeParse({
        ...base,
        drawings: [{ name: "evilOverlay", points: [{ value: 1 }] }],
      }).success,
    ).toBe(false);
    expect(
      savedChartCreateSchema.safeParse({ ...base, indicators: [{ name: "NOPE" }] }).success,
    ).toBe(false);
  });

  it("rejects oversized drawing payloads", () => {
    const tooMany = Array.from({ length: MAX_DRAWINGS + 1 }, () => drawing);
    expect(
      savedChartCreateSchema.safeParse({
        assetId: 1,
        name: "x",
        interval: "1d",
        drawings: tooMany,
        indicators: [],
      }).success,
    ).toBe(false);
  });

  it("rejects an empty patch", () => {
    expect(savedChartPatchSchema.safeParse({}).success).toBe(false);
    expect(savedChartPatchSchema.safeParse({ name: "renamed" }).success).toBe(true);
  });
});
