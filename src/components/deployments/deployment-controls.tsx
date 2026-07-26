"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Pause / activate / stop / delete controls for one deployment. */
export function DeploymentControls({
  id,
  status,
}: {
  id: number;
  status: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = async (next: "active" | "paused" | "stopped") => {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/deployments/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "request failed");
      return;
    }
    router.refresh();
  };

  const remove = async () => {
    if (!window.confirm("Delete this deployment and its history?")) return;
    setBusy(true);
    const res = await fetch(`/api/v1/deployments/${id}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "request failed");
      return;
    }
    router.push("/deployments");
    router.refresh();
  };

  const btn =
    "rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {(status === "paused" || status === "error") && (
          <button className={btn} disabled={busy} onClick={() => patch("active")}>
            {status === "error" ? "Resume" : "Activate"}
          </button>
        )}
        {status === "active" && (
          <button className={btn} disabled={busy} onClick={() => patch("paused")}>
            Pause
          </button>
        )}
        {status !== "stopped" && (
          <button className={btn} disabled={busy} onClick={() => patch("stopped")}>
            Stop
          </button>
        )}
        {status !== "active" && (
          <button
            className={`${btn} text-destructive`}
            disabled={busy}
            onClick={() => void remove()}
          >
            Delete
          </button>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
