import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/server/db/schema";

// tags.ts/history.ts bind the app db module — swap it for PGlite.
vi.mock("@/server/db", async () => {
  const pglite = new PGlite();
  const testDb = drizzle(pglite, { schema });
  await migrate(testDb, { migrationsFolder: "./drizzle" });
  return { db: testDb };
});

import { db } from "@/server/db";
import { getWalletHistory } from "@/server/portfolio/history";
import { listDistinctTags, normalizeTags, setTags } from "@/server/portfolio/tags";

const WALLET = "0xwallet";
let userId: string;

beforeAll(async () => {
  const [user] = await (db as unknown as typeof import("@/server/db").db)
    .insert(schema.users)
    .values({ email: "tags@test.local" })
    .returning();
  userId = user.id;

  const mk = (
    txHash: string,
    over: Partial<typeof schema.walletTransfers.$inferInsert> = {},
  ): typeof schema.walletTransfers.$inferInsert => ({
    userId,
    wallet: WALLET,
    network: "eth-mainnet",
    chainId: 1,
    uniqueId: txHash + (over.assetSymbol ?? ""),
    txHash,
    ts: new Date("2026-07-01T00:00:00Z"),
    direction: "in",
    category: "erc20",
    assetSymbol: "USDC",
    amount: "10",
    ...over,
  });
  await db.insert(schema.walletTransfers).values([
    mk("0xaaa", { assetSymbol: "USDC", direction: "in" }),
    mk("0xbbb", { assetSymbol: "ETH", category: "external", direction: "out" }),
    mk("0xccc", { assetSymbol: "OBS", direction: "in", ts: new Date("2026-07-02T00:00:00Z") }),
  ]);

  const [proposal] = await db
    .insert(schema.tradeProposals)
    .values({
      userId,
      proposal: { tokenIn: { symbol: "ETH" }, tokenOut: { symbol: "USDC" }, amountIn: "1" },
    })
    .returning();
  // A pending execution with no txHash — tagged via its exec:<id> key.
  await db.insert(schema.executions).values({
    userId,
    proposalId: proposal.id,
    userWallet: WALLET,
    chainId: 1,
    txHash: null,
    quote: {},
    status: "pending",
  });
});

describe("normalizeTags", () => {
  it("trims, collapses whitespace, dedupes case-insensitively, enforces limits", () => {
    expect(normalizeTags(["  DeFi  income ", "defi income", "", "x".repeat(33), "ok"])).toEqual([
      "DeFi income",
      "ok",
    ]);
    expect(normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(10);
  });
});

describe("setTags / listDistinctTags", () => {
  it("replaces the tag set and lists distinct tags", async () => {
    await setTags(userId, WALLET, "0xaaa", ["income", "defi"]);
    expect(await setTags(userId, WALLET, "0xaaa", ["income", "salary"])).toEqual([
      "income",
      "salary",
    ]);
    await setTags(userId, WALLET, "0xbbb", ["gas"]);
    expect(await listDistinctTags(userId, WALLET)).toEqual(["gas", "income", "salary"]);
  });

  it("clears tags with an empty set", async () => {
    await setTags(userId, WALLET, "0xccc", ["temp"]);
    expect(await setTags(userId, WALLET, "0xccc", [])).toEqual([]);
    expect(await listDistinctTags(userId, WALLET)).not.toContain("temp");
  });
});

describe("getWalletHistory filters", () => {
  it("attaches tags and filters by tag case-insensitively", async () => {
    await setTags(userId, WALLET, "0xaaa", ["Income"]);
    const all = await getWalletHistory(userId, WALLET);
    expect(all.find((i) => i.txKey === "0xaaa")?.tags).toEqual(["Income"]);

    const tagged = await getWalletHistory(userId, WALLET, { tag: "income" });
    expect(tagged.map((i) => i.txKey)).toEqual(["0xaaa"]);
  });

  it("filters trades by their exec:<id> tag key", async () => {
    const all = await getWalletHistory(userId, WALLET);
    const trade = all.find((i) => i.type === "trade")!;
    expect(trade.txKey).toMatch(/^exec:\d+$/);
    await setTags(userId, WALLET, trade.txKey, ["swap-test"]);

    const byTag = await getWalletHistory(userId, WALLET, { tag: "swap-test" });
    expect(byTag).toHaveLength(1);
    expect(byTag[0].type).toBe("trade");
  });

  it("filters by type, direction, and asset substring", async () => {
    const transfersOnly = await getWalletHistory(userId, WALLET, { type: "transfer" });
    expect(transfersOnly.every((i) => i.type === "transfer")).toBe(true);

    const trades = await getWalletHistory(userId, WALLET, { type: "trade" });
    expect(trades).toHaveLength(1);

    const incoming = await getWalletHistory(userId, WALLET, { direction: "in" });
    expect(incoming.every((i) => i.direction === "in")).toBe(true);
    expect(incoming.some((i) => i.type === "trade")).toBe(false);

    const usdc = await getWalletHistory(userId, WALLET, { asset: "usd", type: "transfer" });
    expect(usdc.map((i) => i.txKey)).toEqual(["0xaaa"]);
  });

  it("returns nothing for a tag no item carries", async () => {
    expect(await getWalletHistory(userId, WALLET, { tag: "nonexistent" })).toEqual([]);
  });
});
