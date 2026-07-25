"use client";

import type { ReactNode } from "react";

/**
 * Shared frame for assistant render blocks: title + content. Restrained,
 * report-like styling consistent with the app.
 */
export function BlockFrame({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="my-3 rounded-md border bg-card">
      {title && (
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <p className="text-sm font-medium">{title}</p>
        </div>
      )}
      <div className="px-4 py-3">{children}</div>
    </div>
  );
}

export function BlockError({ tool, detail }: { tool: string; detail?: string }) {
  return (
    <div className="my-3 rounded-md border border-dashed px-4 py-3 text-xs text-muted-foreground">
      Could not render the {tool.replace(/_/g, " ")} block{detail ? ` (${detail})` : " (invalid data)"}.
    </div>
  );
}

export function BlockPending({ label }: { label: string }) {
  return (
    <div className="my-3 rounded-md border border-dashed px-4 py-3 text-xs text-muted-foreground">
      {label}
    </div>
  );
}
