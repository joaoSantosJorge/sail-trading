import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/server/db/schema";
import type { AlchemyNetwork } from "@/server/portfolio/alchemy";
import type { TransferWithRaw } from "@/server/portfolio/alchemyTransfers";
import { syncTransfers, type TransferDb, type TransferDeps } from "@/server/portfolio/transferCache";

const NOW = Date.parse("2026-07-23T12:00:00Z");
const WALLET = "0x1111111111111111111111111111111111111111";

function transfer(uniqueId: string, network: string, ts = NOW): TransferWithRaw {
  return {
    network,
    chainId: 1,
    uniqueId,
    txHash: uniqueId.split(":")[0],
    ts,
    direction: "in",
    category: "erc20",
    assetSymbol: "USDC",
    assetAddress: "0x2222222222222222222222222222222222222222",
    amount: "100",
    counterparty: "0x3333333333333333333333333333333333333333",
    raw: { uniqueId },
  };
}

let db: TransferDb;
let userId: string;
let fetchCalls: { network: string; fromBlock?: string }[];
let deps: TransferDeps;

beforeEach(async () => {
  const pglite = new PGlite();
  const testDb = drizzle(pglite, { schema });
  await migrate(testDb, { migrationsFolder: "./drizzle" });
  db = testDb as unknown as TransferDb;

  const [user] = await testDb
    .insert(schema.users)
    .values({ email: "t@example.com" })
    .returning({ id: schema.users.id });
  userId = user.id;

  fetchCalls = [];
  deps = {
    fetch: async (network: AlchemyNetwork, _address, fromBlock) => {
      fetchCalls.push({ network, fromBlock });
      if (network !== "eth-mainnet") return { transfers: [], latestBlock: null };
      return {
        transfers: [transfer("0xaaa:log:0", network), transfer("0xbbb:log:0", network)],
        latestBlock: "0x64", // block 100
      };
    },
    now: () => NOW,
  };
});

describe("transferCache.syncTransfers", () => {
  it("inserts fetched transfers and records a per-network watermark", async () => {
    const result = await syncTransfers(db, { userId, wallet: WALLET }, deps);
    expect(result.inserted).toBe(2);
    expect(result.errors).toEqual([]);
    expect(fetchCalls).toHaveLength(5); // one per EVM network
    expect(fetchCalls.every((c) => c.fromBlock === undefined)).toBe(true);
  });

  it("re-sync is incremental (fromBlock = watermark+1) and dedupes rows", async () => {
    await syncTransfers(db, { userId, wallet: WALLET }, deps);
    const second = await syncTransfers(db, { userId, wallet: WALLET }, deps);

    // Same rows fetched again → dedupe on (userId, wallet, uniqueId).
    expect(second.inserted).toBe(0);
    const ethCall = fetchCalls.filter((c) => c.network === "eth-mainnet")[1];
    expect(ethCall.fromBlock).toBe("0x65"); // 0x64 + 1
  });

  it("a failing network reports an error without aborting the others", async () => {
    deps.fetch = async (network) => {
      if (network === "base-mainnet") throw new Error("boom");
      if (network === "eth-mainnet") {
        return { transfers: [transfer("0xccc:log:0", network)], latestBlock: "0x10" };
      }
      return { transfers: [], latestBlock: null };
    };
    const result = await syncTransfers(db, { userId, wallet: WALLET }, deps);
    expect(result.inserted).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("base-mainnet");
  });
});
