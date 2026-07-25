// Live eval for NL -> DSL generation (costs a few cents; not part of vitest).
// Run: pnpm eval:strategygen   Pass criterion (M3): >= 9/10 prompts yield a
// valid strategy whose rendered rules match the stated intent (spot-check).
import { config } from "dotenv";
config({ path: ".env.local" });

const PROMPTS: string[] = [
  "Buy when the 20-day moving average crosses above the 50-day moving average. Sell when it crosses back below.",
  "Go long when RSI drops below 25, exit when it gets back above 60. Use a 5% stop loss.",
  "Buy breakouts: enter when the price closes above the highest high of the last 55 days. Exit when it closes below the lowest low of the last 20 days.",
  "MACD strategy on the 4 hour chart: buy when the MACD line crosses above its signal line, sell on the opposite cross.",
  "Mean reversion with Bollinger Bands: buy when price touches the lower band, sell when it reaches the middle band. 2 standard deviations, 20 period.",
  "Momentum: buy when the 30-day rate of change is above 10% and price is above the 100-day EMA. Exit when momentum turns negative. Only risk half my equity per trade.",
  "Buy hourly dips of 3% below the 24-hour high, take profit at 5%, stop loss at 2%, and wait 12 bars after each exit before re-entering.",
  "Simple trend following on daily candles: long above the 200-day SMA, flat below it.",
  "Volatility filter: enter long when RSI(14) crosses above 50 but only if ATR(14) is below 3% of the closing price. Exit when RSI crosses under 45.",
  "I want to short Bitcoin when it breaks its weekly low.", // inexpressible: should return a clear error, not garbage
];

async function main() {
  const { generateStrategy, StrategyGenError } = await import(
    "../../src/server/ai/strategyGen"
  );
  const { renderCondition, renderIndicators } = await import("../../src/lib/dslRender");

  let valid = 0;
  let cleanRefusals = 0;

  for (const [i, prompt] of PROMPTS.entries()) {
    const label = `[${i + 1}/${PROMPTS.length}]`;
    try {
      const dsl = await generateStrategy(prompt);
      valid += 1;
      console.log(`\n${label} OK — "${dsl.name}" (${dsl.interval})`);
      console.log(`  prompt: ${prompt}`);
      for (const line of renderIndicators(dsl)) console.log(`  ${line}`);
      console.log(`  ENTER when ${renderCondition(dsl.entry)}`);
      console.log(`  EXIT  when ${renderCondition(dsl.exit)}`);
      console.log(`  risk: ${JSON.stringify(dsl.risk)}`);
    } catch (err) {
      if (err instanceof StrategyGenError) {
        cleanRefusals += 1;
        console.log(`\n${label} REFUSED — ${err.message}`);
        console.log(`  prompt: ${prompt}`);
      } else {
        console.log(`\n${label} FAILED — ${(err as Error).message}`);
        console.log(`  prompt: ${prompt}`);
      }
    }
  }

  // The last prompt is intentionally inexpressible — a clean refusal counts as
  // correct behavior there.
  const score = valid + cleanRefusals;
  console.log(`\n=== ${valid} valid, ${cleanRefusals} clean refusals, ${PROMPTS.length - score} failures ===`);
  console.log(score >= 9 ? "PASS (>= 9/10)" : "FAIL (< 9/10)");
  process.exit(score >= 9 ? 0 : 1);
}

main();
