"use client";

import {
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useThreadRuntime,
  type EmptyMessagePartProps,
  type TextMessagePartProps,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { useEffect } from "react";
import { useAssistantDockOptional } from "@/components/assistant/dock/dock-context";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MarkdownMessage } from "@/components/assistant/markdown-message";
import { BacktestBlock } from "@/components/assistant/blocks/backtest-block";
import { MetricsBlock } from "@/components/assistant/blocks/metrics-block";
import { PriceChartBlock } from "@/components/assistant/blocks/price-chart-block";
import { ApprovalCard } from "./approval-card";
import { ProposedActionCard } from "./proposed-action-card";

function formatTimestamp(value: Date | undefined) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function describeToolCall(name: string): string {
  const topic = name.replace(/^(get|list|fetch|render)_/, "").replace(/_/g, " ");
  return `Looking up ${topic}…`;
}

function MessageTimestamp({ className }: { className?: string }) {
  const createdAt = useAuiState((s) => s.message.createdAt);
  return <p className={className}>{formatTimestamp(createdAt)}</p>;
}

function ThinkingIndicator({ label }: { label?: string }) {
  return (
    <div
      className="flex items-center gap-2 py-2 text-xs text-muted-foreground"
      aria-label="Assistant is thinking"
    >
      <span className="flex items-center gap-1" aria-hidden="true">
        <span className="md-thinking-dot" />
        <span className="md-thinking-dot [animation-delay:150ms]" />
        <span className="md-thinking-dot [animation-delay:300ms]" />
      </span>
      {label ? <span>{label}</span> : null}
    </div>
  );
}

function UserText({ text }: TextMessagePartProps) {
  return <p className="whitespace-pre-wrap leading-relaxed">{text}</p>;
}

function AssistantText({ text, status }: TextMessagePartProps) {
  return <MarkdownMessage content={text} isStreaming={status.type === "running"} />;
}

/** Thinking dots while the assistant message has no visible parts yet. */
function AssistantEmpty({ status }: EmptyMessagePartProps) {
  return status.type === "running" ? <ThinkingIndicator /> : null;
}

/**
 * Muted "Looking up …" indicator while a read tool runs; completed tool
 * calls render nothing (results surface through the assistant's text).
 */
function ToolStatusIndicator({ toolName, status }: ToolCallMessagePartProps) {
  if (status.type !== "running" && status.type !== "requires-action") {
    return null;
  }
  return <ThinkingIndicator label={describeToolCall(toolName)} />;
}

// Render tools: the validated args ARE the artifact (chart/backtest args are a
// spec — the block fetches its own data from /api/v1). While streaming we show
// a pending placeholder; once complete, the block renders from the persisted
// part on live turns and reloads alike.
function RenderPriceChartPart({ args, status }: ToolCallMessagePartProps) {
  return <PriceChartBlock args={args} streaming={status.type === "running"} />;
}

function RenderMetricsPart({ args, status }: ToolCallMessagePartProps) {
  return <MetricsBlock args={args} streaming={status.type === "running"} />;
}

function RenderBacktestPart({ args, status }: ToolCallMessagePartProps) {
  return <BacktestBlock args={args} streaming={status.type === "running"} />;
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="max-w-[92%] rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground">
        <MessagePrimitive.Parts components={{ Text: UserText }} />
        <MessageTimestamp className="mt-1 text-[11px] opacity-70" />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="group/assistant-message w-full">
      <div className="min-w-0 text-sm leading-relaxed">
        <MessagePrimitive.Parts
          components={{
            Text: AssistantText,
            Empty: AssistantEmpty,
            // claude-sonnet-5 runs adaptive thinking by default and streams
            // reasoning parts with EMPTY text (display defaults to omitted) —
            // render nothing for them.
            Reasoning: () => null,
            tools: {
              by_name: {
                render_price_chart: RenderPriceChartPart,
                render_metrics: RenderMetricsPart,
                render_backtest: RenderBacktestPart,
                // Approval-gated write tools (src/server/ai/tools/write-tools.ts).
                create_strategy: ApprovalCard,
                run_backtest: ApprovalCard,
                save_research_report: ApprovalCard,
                // Zero-side-effect action proposals: navigate + review page.
                propose_trade: ProposedActionCard,
              },
              Fallback: ToolStatusIndicator,
            },
          }}
        />
      </div>
      <MessagePrimitive.Error>
        <ErrorPrimitive.Root className="mt-2 border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <ErrorPrimitive.Message />
        </ErrorPrimitive.Root>
      </MessagePrimitive.Error>
      <MessageTimestamp className="mt-1.5 text-[11px] text-muted-foreground" />
    </MessagePrimitive.Root>
  );
}

function Composer() {
  const isRunning = useAuiState((s) => s.thread.isRunning);

  return (
    <ComposerPrimitive.Root className="mx-auto flex w-full max-w-3xl flex-col gap-2">
      <ComposerPrimitive.Input
        placeholder="Ask about assets, chart price action, create and backtest a strategy..."
        submitMode="enter"
        rows={1}
        className={cn(
          "flex min-h-16 w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none",
          "placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          "disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
        )}
      />
      <div className="flex items-center justify-end">
        <ComposerPrimitive.Send asChild>
          <Button type="submit">{isRunning ? "Sending..." : "Send"}</Button>
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  );
}

/** Appends a queued "Ask AI" prompt (dock.sendPrompt) once the runtime is idle. */
function PendingPromptConsumer() {
  const dock = useAssistantDockOptional();
  const runtime = useThreadRuntime();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const pending = dock?.pendingPrompt ?? null;

  useEffect(() => {
    if (!pending || isRunning || !dock) return;
    dock.consumePendingPrompt();
    runtime.append({ role: "user", content: [{ type: "text", text: pending }] });
  }, [pending, isRunning, dock, runtime]);

  return null;
}

/**
 * The chat surface: message list + composer. Must be rendered inside
 * AssistantRuntimeProviderV2.
 */
export function ThreadView() {
  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
      <PendingPromptConsumer />
      <ThreadPrimitive.Viewport autoScroll className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
          <ThreadPrimitive.Empty>
            <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">
                One chat across your whole research workflow
              </p>
              <p className="pt-1.5 leading-relaxed">
                It reads your assets, price history, strategies, and backtest results, renders
                charts and metrics inline, and — always with your approval — saves new strategies
                and runs backtests. Everything it claims is grounded in your own data.
              </p>
              <p className="pt-3 font-medium text-foreground">Try:</p>
              <ul className="list-disc space-y-1 pl-4 pt-1.5">
                <li>How has ETH moved over the last month?</li>
                <li>Chart BTC daily with the 50 and 200 day moving averages</li>
                <li>Create a strategy that buys RSI dips under 30 and exits above 55</li>
                <li>Backtest my RSI strategy on ETH and interpret the results</li>
                <li>Compare my strategies&apos; backtests — which held up best?</li>
              </ul>
            </div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </div>
      </ThreadPrimitive.Viewport>

      <div className="border-t p-4">
        <Composer />
      </div>
    </ThreadPrimitive.Root>
  );
}
