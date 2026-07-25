"use client";

import {
  Circle,
  Equal,
  Minus,
  MoveUpRight,
  Rows3,
  Slash,
  Square,
  Tag,
  Trash2,
  TrendingUp,
  UnfoldVertical,
  type LucideIcon,
} from "lucide-react";
import { DRAWING_OVERLAY_NAMES } from "@/lib/chart-state";
import { cn } from "@/lib/utils";

// UI metadata for each overlay in the shared DRAWING_OVERLAY_NAMES list.
const TOOL_UI: Record<(typeof DRAWING_OVERLAY_NAMES)[number], { label: string; icon: LucideIcon }> =
  {
    segment: { label: "Trend line", icon: Slash },
    rayLine: { label: "Ray", icon: MoveUpRight },
    straightLine: { label: "Extended line", icon: TrendingUp },
    horizontalStraightLine: { label: "Horizontal line", icon: Minus },
    verticalStraightLine: { label: "Vertical line", icon: UnfoldVertical },
    priceLine: { label: "Price line", icon: Tag },
    parallelStraightLine: { label: "Parallel channel", icon: Equal },
    rect: { label: "Rectangle", icon: Square },
    circle: { label: "Circle", icon: Circle },
    fibonacciLine: { label: "Fib retracement", icon: Rows3 },
  };

export const DRAWING_TOOLS = DRAWING_OVERLAY_NAMES.map((name) => ({ name, ...TOOL_UI[name] }));

export const DRAWING_TOOL_NAMES: Set<string> = new Set(DRAWING_OVERLAY_NAMES);

export function DrawingToolbar({
  activeTool,
  onSelect,
  onClearAll,
}: {
  activeTool: string | null;
  onSelect: (name: string) => void;
  onClearAll: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-1 rounded-md border border-border bg-muted/30 p-1">
      {DRAWING_TOOLS.map(({ name, label, icon: Icon }) => (
        <button
          key={name}
          type="button"
          title={label}
          aria-label={label}
          onClick={() => onSelect(name)}
          className={cn(
            "rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground",
            activeTool === name && "bg-primary text-primary-foreground hover:bg-primary",
          )}
        >
          <Icon className="size-4" />
        </button>
      ))}
      <span className="mx-1 my-0.5 h-px bg-border" />
      <button
        type="button"
        title="Remove all drawings"
        aria-label="Remove all drawings"
        onClick={onClearAll}
        className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive"
      >
        <Trash2 className="size-4" />
      </button>
    </div>
  );
}
