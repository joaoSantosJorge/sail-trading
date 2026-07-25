import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/server/db/schema";
import { getMacroSeries, type MacroDb, type MacroDeps } from "@/server/macro/macroCache";
import type { MacroObservation } from "@/server/macro/fred";

const NOW = Date.parse("2026-07-22T12:00:00Z");

/** 25 monthly CPI-like points ending 2026-06: value grows 0.25/month from 100. */
function monthlySeries(): MacroObservation[] {
  const out: MacroObservation[] = [];
  for (let i = 0; i < 25; i++) {
    const d = new Date(Date.UTC(2024, 5 + i, 1));
    out.push({ date: d.toISOString().slice(0, 10), value: 100 + i * 0.25 });
  }
  return out;
}

let db: MacroDb;
let fredCalls: string[];
let dbnomicsCalls: string[];
let deps: MacroDeps;
let clock: { now: number };
let fredData: MacroObservation[];
let dbnomicsData: MacroObservation[];

beforeEach(async () => {
  const pglite = new PGlite();
  const testDb = drizzle(pglite, { schema });
  await migrate(testDb, { migrationsFolder: "./drizzle" });
  db = testDb as unknown as MacroDb;

  fredCalls = [];
  dbnomicsCalls = [];
  clock = { now: NOW };
  fredData = monthlySeries();
  dbnomicsData = monthlySeries();
  deps = {
    fetchFred: async (seriesId) => {
      fredCalls.push(seriesId);
      return fredData;
    },
    fetchDbnomics: async (ref) => {
      dbnomicsCalls.push(`${ref.provider}/${ref.dataset}/${ref.series}`);
      return dbnomicsData;
    },
    fredConfigured: () => true,
    now: () => clock.now,
  };
});

describe("macroCache", () => {
  it("prefers FRED, fetches once per TTL window, then serves from the DB", async () => {
    const first = await getMacroSeries(db, "fed-funds", deps);
    expect(fredCalls).toEqual(["FEDFUNDS"]);
    expect(dbnomicsCalls).toHaveLength(0);
    expect(first!.source).toBe("fred");
    expect(first!.stale).toBe(false);
    expect(first!.observations).toHaveLength(25);

    clock.now += 3 * 60 * 60 * 1000; // within 6h TTL
    const second = await getMacroSeries(db, "fed-funds", deps);
    expect(fredCalls).toHaveLength(1); // no new upstream call
    expect(second!.observations).toHaveLength(25);

    clock.now += 4 * 60 * 60 * 1000; // past TTL
    await getMacroSeries(db, "fed-funds", deps);
    expect(fredCalls).toHaveLength(2);
  });

  it("falls back to DBnomics when FRED is unconfigured", async () => {
    deps.fredConfigured = () => false;
    const result = await getMacroSeries(db, "unemployment", deps);
    expect(fredCalls).toHaveLength(0);
    expect(dbnomicsCalls).toEqual(["BLS/ln/LNS14000000"]);
    expect(result!.source).toBe("dbnomics");
    expect(result!.stale).toBe(false);
  });

  it("falls through to DBnomics when the FRED fetch fails", async () => {
    deps.fetchFred = async () => {
      throw new Error("fred down");
    };
    const result = await getMacroSeries(db, "m2", deps);
    expect(dbnomicsCalls).toEqual(["FED/H6_H6_M2/M2.M"]);
    expect(result!.source).toBe("dbnomics");
    expect(result!.stale).toBe(false);
  });

  it("serves cached rows and flags stale when every upstream fails", async () => {
    await getMacroSeries(db, "fed-funds", deps);
    clock.now += 7 * 60 * 60 * 1000;
    deps.fetchFred = async () => {
      throw new Error("fred down");
    };
    deps.fetchDbnomics = async () => {
      throw new Error("dbnomics down");
    };
    const result = await getMacroSeries(db, "fed-funds", deps);
    expect(result!.stale).toBe(true);
    expect(result!.observations).toHaveLength(25); // cache still served
    expect(result!.source).toBe("fred"); // last successful source
  });

  it("is stale with no data for a FRED-only series when FRED is unconfigured", async () => {
    deps.fredConfigured = () => false;
    const result = await getMacroSeries(db, "fed-balance-sheet", deps);
    expect(result!.stale).toBe(true);
    expect(result!.observations).toHaveLength(0);
    expect(dbnomicsCalls).toHaveLength(0); // dbnomics: null — never attempted
  });

  it("computes yoyPct against the same month one year earlier", async () => {
    const result = await getMacroSeries(db, "cpi-yoy", deps);
    // Raw series has 25 monthly points; the first 12 have no prior-year month.
    expect(result!.observations).toHaveLength(13);
    const first = result!.observations[0];
    // 2025-06 vs 2024-06: (103.0 / 100.0 - 1) * 100 = 3.0
    expect(first.date).toBe("2025-06-01");
    expect(first.value).toBeCloseTo(3.0, 10);
    const last = result!.observations[12];
    // 2026-06 (106.0) vs 2025-06 (103.0)
    expect(last.value).toBeCloseTo(100 * (106 / 103 - 1), 10);
  });

  it("upserts upstream revisions on refresh", async () => {
    await getMacroSeries(db, "fed-funds", deps);
    clock.now += 7 * 60 * 60 * 1000;
    fredData = fredData.map((o, i) =>
      i === fredData.length - 1 ? { ...o, value: 999 } : o,
    );
    const result = await getMacroSeries(db, "fed-funds", deps);
    expect(result!.observations).toHaveLength(25); // no duplicates
    expect(result!.observations[24].value).toBe(999); // revised value won
  });

  it("returns null for an unknown slug", async () => {
    expect(await getMacroSeries(db, "nope", deps)).toBeNull();
  });
});
