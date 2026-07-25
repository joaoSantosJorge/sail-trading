import { describe, expect, it } from "vitest";
import { TokenBucket } from "@/server/market/rateLimiter";

describe("TokenBucket", () => {
  it("allows a burst up to capacity, then refuses until refill", () => {
    let now = 0;
    const bucket = new TokenBucket(3, 1, () => now); // 3 capacity, 1 token/sec

    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);

    now = 1000; // 1s later → 1 token refilled
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });

  it("never exceeds capacity after a long idle period", () => {
    let now = 0;
    const bucket = new TokenBucket(2, 10, () => now);
    now = 60_000;
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });
});
