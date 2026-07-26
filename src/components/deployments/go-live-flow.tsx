"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useSignTypedData } from "wagmi";
import { buildApproveAgentFor, splitSignature } from "@/lib/hyperliquid/agent";

type AgentStatus = {
  agentAddress: string;
  approved: boolean;
  validUntil: number | null;
  needsRenewal: boolean;
} | null;

/**
 * Go-live flow for a paused paper deployment:
 *  1. mint/fetch the user's enclave agent (its key never leaves the enclave)
 *  2. one wallet signature approving that agent on Hyperliquid (trade-only,
 *     revocable on-chain, expires)
 *  3. flip the deployment to live
 */
export function GoLiveFlow({ deploymentId }: { deploymentId: number }) {
  const router = useRouter();
  const { address } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const [status, setStatus] = useState<AgentStatus>(null);
  const [configured, setConfigured] = useState(true);
  const [isTestnet, setIsTestnet] = useState(false);
  const [agentName, setAgentName] = useState("sail-live");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!address) return;
    const res = await fetch(`/api/v1/deployments/agent?wallet=${address}`);
    const body = (await res.json().catch(() => null)) as {
      data?: { configured: boolean; agentName: string; isTestnet: boolean; status: AgentStatus };
      error?: string;
    } | null;
    if (!res.ok || !body?.data) {
      setError(body?.error ?? "failed to load agent status");
      return;
    }
    setConfigured(body.data.configured);
    setIsTestnet(body.data.isTestnet);
    setAgentName(body.data.agentName);
    setStatus(body.data.status);
  }, [address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const post = async (path: string, payload: unknown): Promise<Record<string, unknown> | null> => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      setError(((body?.error as string) ?? `request failed (${res.status})`));
      return null;
    }
    return body;
  };

  const approveAgent = async () => {
    if (!address) return;
    setBusy("approve");
    setError(null);
    try {
      // 1) mint (or fetch) the enclave agent address
      const ensured = await post("/api/v1/deployments/agent", { op: "ensure" });
      if (!ensured) return;
      const agentAddress = (ensured.data as { agentAddress: `0x${string}` }).agentAddress;
      // 2) user's main wallet signs the approveAgent typed data
      const { action, nonce, typedData } = buildApproveAgentFor(agentAddress, agentName, isTestnet);
      const hex = await signTypedDataAsync(typedData as never);
      const approved = await post("/api/v1/deployments/agent", {
        op: "approve",
        wallet: address,
        action,
        signature: splitSignature(hex),
        nonce,
      });
      if (approved) await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const goLive = async () => {
    if (!address) return;
    setBusy("golive");
    setError(null);
    const res = await post(`/api/v1/deployments/${deploymentId}/go-live`, { walletAddress: address });
    setBusy(null);
    if (res) router.refresh();
  };

  const btn =
    "rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50";

  if (!configured) {
    return (
      <p className="text-xs text-muted-foreground">
        Live trading is not enabled on this server (managed signer not configured).
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed p-4">
      <p className="text-sm font-medium">Go live {isTestnet && "(testnet)"}</p>
      {!address ? (
        <p className="text-xs text-muted-foreground">
          Connect the wallet you trade with on Hyperliquid (top bar) to enable live mode.
        </p>
      ) : !status?.approved ? (
        <>
          <p className="text-xs text-muted-foreground">
            One wallet signature delegates a trade-only agent key held in a secure enclave — it can
            never withdraw funds, expires automatically, and you can revoke it on Hyperliquid at any
            time.
          </p>
          <button className={btn} disabled={busy !== null} onClick={() => void approveAgent()}>
            {busy === "approve" ? "Approving…" : "Approve trading agent"}
          </button>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Agent {status.agentAddress.slice(0, 8)}… approved
            {status.validUntil ? ` until ${new Date(status.validUntil).toISOString().slice(0, 10)}` : ""}.
            {status.needsRenewal && " Renewal recommended soon."} Going live resets the paper track
            record and trades with real funds within your risk limits.
          </p>
          <div className="flex gap-2">
            <button className={btn} disabled={busy !== null} onClick={() => void goLive()}>
              {busy === "golive" ? "Switching…" : "Switch to live trading"}
            </button>
            {status.needsRenewal && (
              <button
                className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
                disabled={busy !== null}
                onClick={() => void approveAgent()}
              >
                Renew approval
              </button>
            )}
          </div>
        </>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
