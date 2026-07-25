"use client";

import { Check, Save, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { ChartState } from "@/lib/chart-state";
import { cn } from "@/lib/utils";
import type { ChartInterval } from "@/server/market/types";

export type SavedChartInfo = { id: number; name: string };

/** Explicit-save controls in the chart header: "Save chart…" for a fresh
 * chart, "Save" (with dirty dot) + "Save as…" once one is open. */
export function SaveChartControls({
  assetId,
  interval,
  saved,
  dirty,
  getState,
  onSaved,
}: {
  assetId: number;
  interval: ChartInterval;
  saved: SavedChartInfo | null;
  dirty: boolean;
  getState: () => ChartState;
  onSaved: (saved: SavedChartInfo) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const createChart = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/v1/charts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId, name: trimmed, interval, ...getState() }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        data?: SavedChartInfo;
        error?: string;
      };
      if (!res.ok || !data.data) {
        toast.error(data.error ?? "Failed to save chart");
        return;
      }
      toast.success(`Saved “${data.data.name}”`);
      setEditing(false);
      setName("");
      onSaved(data.data);
    } finally {
      setBusy(false);
    }
  };

  const updateChart = async () => {
    if (!saved || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/charts/${saved.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval, ...getState() }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "Failed to save chart");
        return;
      }
      toast.success(`Saved “${saved.name}”`);
      onSaved(saved);
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <span className="flex items-center gap-1">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void createChart();
            if (e.key === "Escape") setEditing(false);
          }}
          placeholder="Chart name"
          maxLength={80}
          className="h-6 w-36 rounded border border-border bg-background px-2 text-xs"
        />
        <button
          type="button"
          title="Save"
          onClick={() => void createChart()}
          disabled={busy || !name.trim()}
          className="rounded p-1 text-success hover:bg-accent disabled:opacity-40"
        >
          <Check className="size-3.5" />
        </button>
        <button
          type="button"
          title="Cancel"
          onClick={() => setEditing(false)}
          className="rounded p-1 text-muted-foreground hover:bg-accent"
        >
          <X className="size-3.5" />
        </button>
      </span>
    );
  }

  if (!saved) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
      >
        <Save className="size-3.5" /> Save chart…
      </button>
    );
  }

  return (
    <span className="flex items-center gap-1.5">
      <span className="max-w-40 truncate text-xs text-muted-foreground" title={saved.name}>
        {saved.name}
      </span>
      <button
        type="button"
        onClick={() => void updateChart()}
        disabled={busy}
        className={cn(
          "flex items-center gap-1 rounded border px-2 py-1 text-xs",
          dirty
            ? "border-primary text-primary hover:bg-accent"
            : "border-border text-muted-foreground hover:bg-accent",
        )}
      >
        <Save className="size-3.5" />
        Save
        {dirty && <span className="size-1.5 rounded-full bg-primary" />}
      </button>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
      >
        Save as…
      </button>
    </span>
  );
}
