"use client";

import { useState } from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { Button } from "@/components/ui/button";
import { renderCondition, renderIndicators, renderRisk } from "@/lib/dslRender";
import type { StrategyDSL } from "@/server/engine/types";

/**
 * Approval card for the AI assistant's write tools (`needsApproval`).
 *
 * States, derived from the tool part:
 * - approval pending (`approval.approved === undefined`) → summary +
 *   Approve / Decline buttons (respondToApproval).
 * - approved, no result yet → executing.
 * - approved + result → inert "Approved — executed" (or the tool's error).
 * - declined → inert "Declined".
 */

type ToolArgs = Record<string, unknown>;

const TOOL_TITLES: Record<string, string> = {
  create_strategy: "Save strategy",
  run_backtest: "Run backtest",
  save_research_report: "Save research report",
};

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Defensive human-readable DSL summary — args may be malformed/partial. */
function StrategySummary({ raw }: { raw: unknown }) {
  try {
    const dsl = raw as StrategyDSL;
    if (!dsl || typeof dsl !== "object" || !dsl.entry || !dsl.exit) {
      return <p className="text-sm">Save a new strategy (details unavailable).</p>;
    }
    return (
      <div className="space-y-1.5 text-sm">
        <p>
          <span className="font-medium">{dsl.name ?? "Unnamed strategy"}</span>{" "}
          <span className="text-muted-foreground">({dsl.interval})</span>
        </p>
        <div className="rounded border bg-muted/30 p-2 font-mono text-xs leading-relaxed">
          {renderIndicators(dsl).map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p className="mt-1">
            <span className="text-success">ENTER</span> when {renderCondition(dsl.entry)}
          </p>
          <p>
            <span className="text-destructive">EXIT</span> when {renderCondition(dsl.exit)}
          </p>
          <p className="mt-1 text-muted-foreground">{renderRisk(dsl).join(" · ")}</p>
        </div>
      </div>
    );
  } catch {
    return <p className="text-sm">Save a new strategy (could not render rules).</p>;
  }
}

function BacktestSummary({ args }: { args: ToolArgs }) {
  const params = (args.params ?? {}) as ToolArgs;
  const fee = asNumber(params.feeBps) ?? 30;
  const slippage = asNumber(params.slippageBps) ?? 10;
  const gas = asNumber(params.gasUsd) ?? 1;
  const equity = asNumber(params.initialEquity) ?? 10_000;
  return (
    <p className="text-sm">
      Run strategy #{asNumber(args.strategyId) ?? "—"} on asset #{asNumber(args.assetId) ?? "—"} ·
      fee {fee}bps · slippage {slippage}bps · gas ${gas} · start $
      {equity.toLocaleString()}
    </p>
  );
}

function ResolvedBadge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "ok" | "muted" | "error";
}) {
  const cls =
    tone === "ok"
      ? "text-foreground"
      : tone === "error"
        ? "text-destructive"
        : "text-muted-foreground";
  return <p className={`text-xs font-medium ${cls}`}>{children}</p>;
}

export function ApprovalCard(props: ToolCallMessagePartProps) {
  const { toolName, args, result, isError, approval, respondToApproval } = props;
  const [responding, setResponding] = useState(false);

  const title = TOOL_TITLES[toolName] ?? toolName.replace(/_/g, " ");
  const toolArgs = (args ?? {}) as ToolArgs;

  const resultError =
    result && typeof result === "object" && "error" in result
      ? String((result as { error: unknown }).error)
      : undefined;

  const pending = approval != null && approval.approved === undefined;
  const declined = approval?.approved === false;
  const approved = approval?.approved === true;
  const executing = approved && result === undefined && !isError;

  return (
    <div className="my-2 rounded-lg border border-border bg-card px-4 py-3">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Approval required — {title}
      </p>
      <div className="mt-1.5">
        {toolName === "create_strategy" ? (
          <StrategySummary raw={toolArgs.dsl} />
        ) : toolName === "run_backtest" ? (
          <BacktestSummary args={toolArgs} />
        ) : toolName === "save_research_report" ? (
          <p className="text-sm">
            Save &ldquo;{String(toolArgs.title ?? "Untitled report")}&rdquo; (
            {String(toolArgs.reportMd ?? "").length.toLocaleString()} chars) to Documents &rarr;
            Reports.
          </p>
        ) : (
          <p className="text-sm">The assistant requests approval for this action.</p>
        )}
      </div>

      <div className="mt-3">
        {pending ? (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={responding}
              onClick={() => {
                setResponding(true);
                respondToApproval({ approved: true });
              }}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={responding}
              onClick={() => {
                setResponding(true);
                respondToApproval({ approved: false });
              }}
            >
              Decline
            </Button>
          </div>
        ) : declined ? (
          <ResolvedBadge tone="muted">Declined — nothing was changed.</ResolvedBadge>
        ) : executing ? (
          <ResolvedBadge tone="muted">Approved — executing…</ResolvedBadge>
        ) : isError || resultError ? (
          <ResolvedBadge tone="error">
            Approved — failed: {resultError ?? "execution error"}
          </ResolvedBadge>
        ) : approved || result !== undefined ? (
          <ResolvedBadge tone="ok">Approved — executed.</ResolvedBadge>
        ) : (
          <ResolvedBadge tone="muted">Awaiting approval…</ResolvedBadge>
        )}
      </div>
    </div>
  );
}
