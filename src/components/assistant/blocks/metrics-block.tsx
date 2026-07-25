"use client";

import { cn } from "@/lib/utils";
import { metricsSpecSchema } from "@/lib/ai/render-schemas";
import { BlockError, BlockFrame, BlockPending } from "./block-frame";

/**
 * KPI tile row rendered from the validated render_metrics tool args (the args
 * ARE the artifact — re-parsed defensively so historical parts can't crash).
 */
export function MetricsBlock({ args, streaming }: { args: unknown; streaming?: boolean }) {
  const parsed = metricsSpecSchema.safeParse(args);
  if (!parsed.success) {
    return streaming ? (
      <BlockPending label="Preparing metrics…" />
    ) : (
      <BlockError tool="render_metrics" />
    );
  }
  const input = parsed.data;

  return (
    <BlockFrame title={input.title}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {input.items.map((item, i) => {
          const negative = item.delta?.trim().startsWith("-");
          const good =
            item.goodWhen === undefined || !item.delta
              ? null
              : item.goodWhen === "down"
                ? negative
                : !negative;
          return (
            <div key={i} className="rounded-md border px-3 py-2.5">
              <p className="truncate text-xs text-muted-foreground">{item.label}</p>
              <p className="mt-0.5 text-base font-semibold tabular-nums">{item.value}</p>
              {item.delta && (
                <span
                  className={cn(
                    "text-xs tabular-nums",
                    good === null && "text-muted-foreground",
                    good === true && "text-success",
                    good === false && "text-destructive",
                  )}
                >
                  {item.delta}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </BlockFrame>
  );
}
