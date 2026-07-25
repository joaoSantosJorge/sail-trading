"use client";

import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { Button } from "@/components/ui/button";
import type { ProposedAction } from "@/lib/ai/action-schemas";

/**
 * Card for zero-side-effect action tools (propose_trade). When a FRESH
 * proposal arrives (result just streamed in, not a reloaded historical part),
 * navigate once to the review page; historical parts render an inert card
 * with a manual "Open & review" button.
 */

const FRESH_WINDOW_MS = 2 * 60 * 1000;

function isProposedAction(value: unknown): value is ProposedAction {
  return (
    typeof value === "object" &&
    value !== null &&
    "proposalId" in value &&
    "targetPath" in value &&
    "summary" in value
  );
}

// Module-level so a remount (e.g. thread reload) never re-navigates the same
// proposal in this browser session.
const navigated = new Set<number>();

export function ProposedActionCard({ result, isError, status }: ToolCallMessagePartProps) {
  const router = useRouter();
  const attemptedRef = useRef(false);

  const action = isProposedAction(result) ? result : null;
  const errorText =
    result && typeof result === "object" && "error" in result
      ? String((result as { error: unknown }).error)
      : null;

  const fresh =
    action !== null &&
    Date.now() - new Date(action.expiresAt).getTime() + 24 * 60 * 60 * 1000 < FRESH_WINDOW_MS;

  useEffect(() => {
    if (!action || !fresh || attemptedRef.current) return;
    if (navigated.has(action.proposalId)) return;
    attemptedRef.current = true;
    navigated.add(action.proposalId);
    router.push(action.targetPath);
  }, [action, fresh, router]);

  if (status.type === "running") {
    return (
      <div className="my-2 rounded-lg border border-dashed px-4 py-3 text-xs text-muted-foreground">
        Preparing trade proposal…
      </div>
    );
  }

  if (isError || errorText) {
    return (
      <div className="my-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Trade proposal rejected
        </p>
        <p className="mt-1 text-sm text-destructive">{errorText ?? "validation failed"}</p>
      </div>
    );
  }

  if (!action) return null;

  return (
    <div className="my-2 rounded-lg border border-border bg-card px-4 py-3">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Trade proposal #{action.proposalId}
      </p>
      <dl className="mt-2 space-y-1 text-sm">
        {action.summary.map((row) => (
          <div key={row.label} className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="text-right font-medium">{row.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Nothing executes without your wallet signature. Expires{" "}
        {new Date(action.expiresAt).toLocaleString()}.
      </p>
      <div className="mt-3">
        <Button size="sm" onClick={() => router.push(action.targetPath)}>
          Open &amp; review
          <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
