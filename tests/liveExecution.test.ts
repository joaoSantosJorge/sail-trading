import { describe, expect, it } from "vitest";
import {
  ExecutionError,
  makeCloid,
  parseOrderResponse,
  withUserSigningLock,
} from "@/server/deployments/execution";
import { checkAggregateExposure, RiskError } from "@/server/deployments/risk";

describe("makeCloid", () => {
  it("is deterministic and wire-shaped (0x + 32 hex)", () => {
    const a = makeCloid(7, 1_785_100_500_000, "entry");
    const b = makeCloid(7, 1_785_100_500_000, "entry");
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{32}$/);
  });

  it("differs across deployment, bar, and intent", () => {
    const base = makeCloid(1, 1000, "entry");
    expect(makeCloid(2, 1000, "entry")).not.toBe(base);
    expect(makeCloid(1, 2000, "entry")).not.toBe(base);
    expect(makeCloid(1, 1000, "exit")).not.toBe(base);
  });
});

describe("withUserSigningLock", () => {
  it("serializes calls for the same user", async () => {
    const order: number[] = [];
    const slow = withUserSigningLock("u1", async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
    });
    const fast = withUserSigningLock("u1", async () => {
      order.push(2);
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual([1, 2]);
  });

  it("continues after a failed holder", async () => {
    await expect(
      withUserSigningLock("u2", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withUserSigningLock("u2", async () => "ok")).resolves.toBe("ok");
  });

  it("does not serialize across users", async () => {
    const order: number[] = [];
    const a = withUserSigningLock("u3", async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
    });
    const b = withUserSigningLock("u4", async () => {
      order.push(2);
    });
    await Promise.all([a, b]);
    expect(order).toEqual([2, 1]);
  });
});

describe("parseOrderResponse", () => {
  const ok = (statuses: unknown[]) => ({
    status: "ok",
    response: { data: { statuses } },
  });

  it("parses an immediate fill with resting triggers", () => {
    const out = parseOrderResponse(
      ok([
        { filled: { oid: 11, totalSz: "0.5", avgPx: "64000.1" } },
        { resting: { oid: 12 } },
        { resting: { oid: 13 } },
      ]),
      "0xabc",
    );
    expect(out).toMatchObject({
      oid: 11,
      filled: true,
      avgPx: 64000.1,
      totalSz: 0.5,
      triggerOids: [12, 13],
      triggerErrors: [],
    });
  });

  it("parses a resting entry", () => {
    const out = parseOrderResponse(ok([{ resting: { oid: 21 } }]), "0xabc");
    expect(out).toMatchObject({ oid: 21, filled: false, avgPx: null });
  });

  it("collects trigger errors without failing the entry", () => {
    const out = parseOrderResponse(
      ok([{ filled: { oid: 1, totalSz: "1", avgPx: "10" } }, { error: "Price too far" }]),
      "0xabc",
    );
    expect(out.triggerErrors).toEqual(["Price too far"]);
    expect(out.triggerOids).toEqual([]);
  });

  it("throws on a rejected entry", () => {
    expect(() => parseOrderResponse(ok([{ error: "Insufficient margin" }]), "0xabc")).toThrow(
      ExecutionError,
    );
    expect(() => parseOrderResponse({ status: "err" }, "0xabc")).toThrow(ExecutionError);
  });
});

describe("checkAggregateExposure", () => {
  it("allows exposure under the cap and rejects over it", () => {
    // default MAX_ACCOUNT_EXPOSURE_PCT = 80 → cap on $10k account = $8k
    expect(() =>
      checkAggregateExposure({
        newNotionalUsd: 900,
        accountValueUsd: 10_000,
        existingBotNotionalUsd: 7000,
      }),
    ).not.toThrow();
    expect(() =>
      checkAggregateExposure({
        newNotionalUsd: 1100,
        accountValueUsd: 10_000,
        existingBotNotionalUsd: 7000,
      }),
    ).toThrow(RiskError);
  });
});
