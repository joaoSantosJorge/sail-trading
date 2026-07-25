// One knob per pipeline. All calls go through @ai-sdk/anthropic, which reads
// ANTHROPIC_API_KEY from the environment.
export const MODELS = {
  chat: "claude-sonnet-5",
  strategyGen: "claude-sonnet-5",
  utility: "claude-haiku-4-5", // thread titles + rolling summaries
} as const;

export function aiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
