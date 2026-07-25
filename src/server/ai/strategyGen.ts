import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { z } from "zod";
import {
  StrategyDSLSchema,
  validateSemantics,
  type StrategyDSL,
} from "../engine/types";
import { aiConfigured, MODELS } from "./client";
import { STRATEGY_GEN_SYSTEM } from "./prompts";

export class StrategyGenError extends Error {}

/** Model may return {"error": "..."} for requests the DSL can't express. */
const ModelRefusalSchema = z.object({ error: z.string() });

function extractJson(text: string): unknown {
  // Defensive: strip markdown fences if the model added them anyway.
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new StrategyGenError("model did not return valid JSON");
  }
}

/** Parse + full validation; returns list of problems instead of throwing. */
function validate(raw: unknown): { dsl?: StrategyDSL; problems: string[] } {
  const refusal = ModelRefusalSchema.safeParse(raw);
  if (refusal.success) {
    throw new StrategyGenError(refusal.data.error);
  }
  const parsed = StrategyDSLSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  const dsl = parsed.data as StrategyDSL;
  const problems = validateSemantics(dsl);
  return problems.length > 0 ? { problems } : { dsl, problems: [] };
}

async function callModel(userContent: string): Promise<string> {
  if (!aiConfigured()) {
    throw new StrategyGenError(
      "ANTHROPIC_API_KEY is not set — add it to .env.local to use AI features",
    );
  }
  const { text } = await generateText({
    model: anthropic(MODELS.strategyGen),
    system: STRATEGY_GEN_SYSTEM,
    prompt: userContent,
    maxOutputTokens: 8000,
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
  });
  if (!text) throw new StrategyGenError("model returned no text");
  return text;
}

/**
 * Natural language -> validated StrategyDSL. One repair round: if the first
 * attempt fails schema/semantic validation, the errors are fed back once.
 * Throws StrategyGenError with the remaining problems if that also fails.
 */
export async function generateStrategy(prompt: string): Promise<StrategyDSL> {
  const first = extractJson(await callModel(prompt));
  const attempt1 = validate(first);
  if (attempt1.dsl) return attempt1.dsl;

  const repairPrompt = `${prompt}

Your previous attempt was:
${JSON.stringify(first)}

It failed validation with these errors:
${attempt1.problems.map((p) => `- ${p}`).join("\n")}

Fix these issues and output the corrected JSON object. Change nothing else.`;

  const second = extractJson(await callModel(repairPrompt));
  const attempt2 = validate(second);
  if (attempt2.dsl) return attempt2.dsl;

  throw new StrategyGenError(
    `generated strategy failed validation twice: ${attempt2.problems.join("; ")}`,
  );
}
