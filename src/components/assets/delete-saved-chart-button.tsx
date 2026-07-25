"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function DeleteSavedChartButton({ chartId, name }: { chartId: number; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    if (!window.confirm(`Delete saved chart "${name}"?`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/charts/${chartId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      router.refresh();
    } catch {
      setBusy(false);
      window.alert("Failed to delete the chart — try again.");
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={onDelete}
      disabled={busy}
      aria-label={`Delete ${name}`}
      className="text-muted-foreground hover:text-destructive"
    >
      <Trash2 />
    </Button>
  );
}
