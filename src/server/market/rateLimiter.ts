export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private capacity: number,
    private refillPerSec: number,
    private now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = this.now();
  }

  private refill(): void {
    const n = this.now();
    const elapsedSec = (n - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.lastRefill = n;
  }

  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Resolves once a token is available (waits if the bucket is empty). */
  async take(): Promise<void> {
    for (;;) {
      if (this.tryTake()) return;
      const deficitMs = ((1 - this.tokens) / this.refillPerSec) * 1000;
      await new Promise((resolve) => setTimeout(resolve, Math.max(10, deficitMs)));
    }
  }
}
