"use client";

import { CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useAccount, useSignTypedData } from "wagmi";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConnectWalletButton } from "@/components/web3/connect-wallet-button";
import {
  buildApproveAgent,
  getOrCreateAgentKey,
  signAgentAction,
  splitSignature,
  type AgentKey,
} from "@/lib/hyperliquid/agent";
import type { ValidatedPerpProposal } from "@/server/trade/perpProposals";

type PerpQuote = {
  quoteId: string;
  validForMs: number;
  coin: string;
  side: "long" | "short";
  size: string;
  px: string;
  markPx: number;
  notionalUsd: number;
  leverage: number;
  tif: string;
  reduceOnly: boolean;
  orderAction: Record<string, unknown>;
  updateLeverageAction: Record<string, unknown> | null;
  isTestnet: boolean;
};

type ExecResult = { status: string; oid: number | null; fill: { totalSz: string; avgPx: string } | null; resting: boolean };

export function PerpTradeFlow({
  proposalId,
  status,
  proposal,
  isTestnet,
}: {
  proposalId: number;
  status: string;
  proposal: ValidatedPerpProposal;
  isTestnet: boolean;
}) {
  const router = useRouter();
  const { address } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();

  const [agent, setAgent] = useState<AgentKey | null>(null);
  const [agentApproved, setAgentApproved] = useState<boolean | null>(null);
  const [quote, setQuote] = useState<PerpQuote | null>(null);
  const [quotedAt, setQuotedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ExecResult | null>(null);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const walletMatches = address?.toLowerCase() === proposal.walletAddress.toLowerCase();
  const remainingMs = quote ? Math.max(0, quote.validForMs - (now - quotedAt)) : 0;
  const quoteLive = quote !== null && remainingMs > 0;
  const terminal = ["executed", "dismissed", "expired"].includes(status);

  // Agent status: the tab's key must exist AND the venue must list it approved.
  const checkAgent = useCallback(async () => {
    if (!walletMatches || !address) return;
    const key = getOrCreateAgentKey(address, isTestnet);
    setAgent(key);
    try {
      const res = await fetch(`/api/v1/trade/perp/agent?wallet=${address.toLowerCase()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const agents = (data.data.agents ?? []) as { address: string; validUntil: number }[];
      setAgentApproved(
        agents.some(
          (a) => a.address.toLowerCase() === key.address.toLowerCase() && a.validUntil > Date.now(),
        ),
      );
    } catch {
      setAgentApproved(null);
    }
  }, [address, walletMatches, isTestnet]);

  useEffect(() => {
    void checkAgent();
  }, [checkAgent]);

  async function enableTrading() {
    if (!agent) return;
    setBusy("agent");
    try {
      const { action, nonce, typedData } = buildApproveAgent(agent, isTestnet);
      const hex = await signTypedDataAsync(typedData as never);
      const res = await fetch("/api/v1/trade/perp/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, signature: splitSignature(hex), nonce }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAgentApproved(true);
      toast.success("Trading enabled — agent key approved (this tab only)");
    } catch (err) {
      toast.error(err instanceof Error ? err.message.slice(0, 200) : "agent approval failed");
    } finally {
      setBusy(null);
    }
  }

  async function getQuote() {
    setBusy("quote");
    try {
      const res = await fetch("/api/v1/trade/perp/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposalId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setQuote(data.data);
      setQuotedAt(Date.now());
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "quote failed");
    } finally {
      setBusy(null);
    }
  }

  async function submitOrder() {
    if (!quote || !agent) return;
    setBusy("submit");
    try {
      // The agent key signs the server-minted actions VERBATIM in-browser;
      // the private key never leaves sessionStorage.
      const order = await signAgentAction(agent, quote.orderAction, quote.isTestnet);
      const updateLeverage = quote.updateLeverageAction
        ? await signAgentAction(agent, quote.updateLeverageAction, quote.isTestnet)
        : undefined;

      const res = await fetch("/api/v1/trade/perp/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quoteId: quote.quoteId, order, updateLeverage }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult(data.data);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message.slice(0, 200) : "order failed");
    } finally {
      setBusy(null);
    }
  }

  if (result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {result.status === "confirmed" ? (
              <CheckCircle2 className="h-5 w-5 text-success" />
            ) : (
              <Loader2 className="h-5 w-5 animate-spin" />
            )}
            Order {result.status === "confirmed" ? "filled" : "resting"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {result.fill ? (
            <p>
              Filled {result.fill.totalSz} {proposal.coin} at avg{" "}
              <span className="font-mono">{result.fill.avgPx}</span>
            </p>
          ) : (
            <p className="text-muted-foreground">
              The order is resting in the book (oid {result.oid}) — it fills when the market
              reaches your price. The proposal is marked executed.
            </p>
          )}
          {result.oid !== null && (
            <p className="font-mono text-xs text-muted-foreground">order id {result.oid}</p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Execute on Hyperliquid{isTestnet ? " (testnet)" : ""}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {terminal && (
          <p className="text-sm text-muted-foreground">This proposal is {status} — no further actions.</p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <ConnectWalletButton />
          {address && !walletMatches && (
            <p className="text-xs text-destructive">
              Connected wallet does not match the proposal wallet ({proposal.walletAddress.slice(0, 8)}…)
            </p>
          )}
        </div>

        {/* Step 1 — one-time agent approval (per tab) */}
        {walletMatches && !terminal && agentApproved === false && (
          <div className="rounded-md border p-3 text-sm">
            <p className="flex items-center gap-2 font-medium">
              <KeyRound className="h-4 w-4" /> Enable trading on Hyperliquid
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              One wallet signature approves a trade-only agent key generated in this browser tab.
              The key cannot withdraw funds, is never sent to any server, and dies with the tab.
            </p>
            <Button size="sm" className="mt-2" onClick={enableTrading} disabled={busy !== null}>
              {busy === "agent" ? "Waiting for wallet…" : "Approve agent key"}
            </Button>
          </div>
        )}
        {walletMatches && agentApproved && (
          <p className="flex items-center gap-1.5 text-xs text-success">
            <CheckCircle2 className="h-3.5 w-3.5" /> Agent key approved for this tab
          </p>
        )}

        {/* Step 2 — quote */}
        <div className="flex items-center gap-3">
          <Button
            onClick={getQuote}
            disabled={terminal || busy !== null || !walletMatches}
            variant={quoteLive ? "outline" : "default"}
          >
            {busy === "quote" ? "Quoting…" : quoteLive ? "Re-quote" : "Get quote"}
          </Button>
          {quote && (
            <span className="text-xs text-muted-foreground">
              {quoteLive ? `valid ${Math.ceil(remainingMs / 1000)}s` : "quote expired — re-quote"}
            </span>
          )}
        </div>

        {quote && (
          <div className="rounded-md border p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Order</span>
              <span className="font-mono tabular-figures">
                {quote.side.toUpperCase()} {quote.size} {quote.coin}-PERP
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                {proposal.orderType === "market" ? "Worst fill price" : "Limit price"}
              </span>
              <span className="font-mono tabular-figures">{quote.px}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Mark price</span>
              <span className="font-mono tabular-figures">{quote.markPx}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Notional</span>
              <span className="font-mono tabular-figures">${quote.notionalUsd.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Leverage</span>
              <span>
                {quote.leverage}x cross{quote.reduceOnly ? " · reduce-only" : ""}
              </span>
            </div>
          </div>
        )}

        {/* Step 3 — sign with the agent key + relay */}
        <Button
          onClick={submitOrder}
          disabled={!quoteLive || terminal || busy !== null || !walletMatches || !agentApproved}
          className="w-full"
        >
          {busy === "submit" ? "Submitting…" : "Sign & submit order"}
        </Button>
        <p className="text-center text-[11px] text-muted-foreground">
          The order is signed in this browser by your approved agent key and relayed unchanged.
          Nothing can execute without this signature.
        </p>
      </CardContent>
    </Card>
  );
}
