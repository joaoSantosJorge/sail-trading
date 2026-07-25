"use client";

import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useAccount, useSendTransaction, useSignTypedData, useSwitchChain } from "wagmi";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConnectWalletButton } from "@/components/web3/connect-wallet-button";
import type { ValidatedProposal } from "@/server/trade/proposals";

type QuoteData = {
  quoteId: string;
  validForMs: number;
  amountIn: string;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  tokenOutDecimals: number;
  amountOutRaw: string | null;
  priceImpactPct: number | null;
  routing: string | null;
  approvalTx: { to: string; data: string; value: string } | null;
  permitData: Record<string, unknown> | null;
};

function formatRaw(raw: string | null, decimals: number): string {
  if (!raw) return "—";
  const value = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = (value % base).toString().padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function TradeFlow({
  proposalId,
  status,
  proposal,
  tradingConfigured,
}: {
  proposalId: number;
  status: string;
  proposal: ValidatedProposal;
  tradingConfigured: boolean;
}) {
  const router = useRouter();
  const { address, chainId: connectedChainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const { signTypedDataAsync } = useSignTypedData();

  const [quote, setQuote] = useState<QuoteData | null>(null);
  const [quotedAt, setQuotedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [approvalDone, setApprovalDone] = useState(false);
  const [impactOverride, setImpactOverride] = useState(false);
  const [result, setResult] = useState<{ status: string; txHash: string } | null>(null);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const remainingMs = quote ? Math.max(0, quote.validForMs - (now - quotedAt)) : 0;
  const quoteLive = quote !== null && remainingMs > 0;

  const walletMatches = address?.toLowerCase() === proposal.walletAddress.toLowerCase();
  const rightChain = connectedChainId === proposal.chainId;

  const minReceived = useMemo(() => {
    if (!quote?.amountOutRaw) return "—";
    const out = BigInt(quote.amountOutRaw);
    const min = (out * BigInt(10_000 - proposal.maxSlippageBps)) / 10_000n;
    return formatRaw(min.toString(), quote.tokenOutDecimals);
  }, [quote, proposal.maxSlippageBps]);

  const impact = quote?.priceImpactPct ?? null;
  const impactWarn = impact !== null && impact > 2;
  const impactBlock = impact !== null && impact > 5 && !impactOverride;

  async function getQuote() {
    setBusy("quote");
    try {
      const res = await fetch("/api/v1/trade/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposalId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setQuote(data.data);
      setQuotedAt(Date.now());
      setApprovalDone(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "quote failed");
    } finally {
      setBusy(null);
    }
  }

  async function sendApproval() {
    if (!quote?.approvalTx) return;
    setBusy("approval");
    try {
      if (!rightChain) await switchChainAsync({ chainId: proposal.chainId });
      await sendTransactionAsync({
        to: quote.approvalTx.to as `0x${string}`,
        data: quote.approvalTx.data as `0x${string}`,
        value: BigInt(quote.approvalTx.value ?? "0"),
      });
      setApprovalDone(true);
      toast.success("Approval transaction sent");
    } catch (err) {
      toast.error(err instanceof Error ? err.message.slice(0, 200) : "approval failed");
    } finally {
      setBusy(null);
    }
  }

  async function confirmAndSwap() {
    if (!quote) return;
    setBusy("swap");
    try {
      if (!rightChain) await switchChainAsync({ chainId: proposal.chainId });

      // Permit2 signature (gasless) when the quote carries permitData.
      let signature: string | undefined;
      const pd = quote.permitData as {
        domain?: Record<string, unknown>;
        types?: Record<string, unknown>;
        values?: Record<string, unknown>;
      } | null;
      if (pd?.domain && pd.types && pd.values) {
        const primaryType =
          "PermitSingle" in pd.types ? "PermitSingle" : Object.keys(pd.types)[0];
        // wagmi's generic inference can't type dynamic EIP-712 payloads —
        // pass the API-provided typed data through as-is.
        signature = await signTypedDataAsync({
          domain: pd.domain,
          types: pd.types,
          primaryType,
          message: pd.values,
        } as never);
      }

      const res = await fetch("/api/v1/trade/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quoteId: quote.quoteId, signature }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const { executionId, tx } = data.data as {
        executionId: number;
        tx: { to: string; data: string; value: string };
      };

      const txHash = await sendTransactionAsync({
        to: tx.to as `0x${string}`,
        data: tx.data as `0x${string}`,
        value: BigInt(tx.value ?? "0"),
      });
      toast.success("Swap submitted — verifying on-chain…");

      const patch = await fetch(`/api/v1/executions/${executionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txHash }),
      });
      const patchData = await patch.json();
      setResult(patchData.data ?? { status: "pending", txHash });
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message.slice(0, 200) : "swap failed");
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
            Swap {result.status}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="break-all font-mono text-xs">{result.txHash}</p>
          <p className="text-muted-foreground">
            {result.status === "confirmed"
              ? "Verified on-chain. The proposal is marked executed."
              : result.status === "failed"
                ? "The transaction reverted on-chain."
                : "Receipt not verified yet — it may still confirm."}
          </p>
        </CardContent>
      </Card>
    );
  }

  const terminal = ["executed", "dismissed", "expired"].includes(status);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Execute</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!tradingConfigured && (
          <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground">
            UNISWAP_API_KEY is not set — quoting and execution are disabled until it is added to
            .env.local.
          </p>
        )}
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

        {/* Step 1 — quote */}
        <div className="flex items-center gap-3">
          <Button
            onClick={getQuote}
            disabled={!tradingConfigured || terminal || busy !== null}
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
              <span className="text-muted-foreground">You sell</span>
              <span className="font-mono tabular-figures">
                {quote.amountIn} {quote.tokenInSymbol}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Expected receive</span>
              <span className="font-mono tabular-figures">
                {formatRaw(quote.amountOutRaw, quote.tokenOutDecimals)} {quote.tokenOutSymbol}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Minimum received</span>
              <span className="font-mono tabular-figures">
                {minReceived} {quote.tokenOutSymbol}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Max slippage</span>
              <span>{proposal.maxSlippageBps} bps</span>
            </div>
            {impact !== null && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Price impact</span>
                <span className={impactWarn ? "font-medium text-destructive" : ""}>
                  {impact.toFixed(2)}%
                </span>
              </div>
            )}
            {quote.routing && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Route</span>
                <span>{quote.routing}</span>
              </div>
            )}
          </div>
        )}

        {impactWarn && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div>
              <p className="text-destructive">
                Price impact is {impact!.toFixed(2)}% — this trade moves the market significantly.
              </p>
              {impact! > 5 && (
                <label className="mt-1 flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={impactOverride}
                    onChange={(e) => setImpactOverride(e.target.checked)}
                  />
                  I understand the impact is over 5% and want to proceed anyway
                </label>
              )}
            </div>
          </div>
        )}

        {/* Step 2 — one-time token approval (ERC-20 inputs only) */}
        {quote?.approvalTx && !approvalDone && (
          <div className="rounded-md border p-3 text-sm">
            <p className="font-medium">One-time approval needed</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Allow Permit2 to move your {quote.tokenInSymbol} (standard Uniswap approval, once
              per token).
            </p>
            <Button
              size="sm"
              className="mt-2"
              onClick={sendApproval}
              disabled={busy !== null || !walletMatches}
            >
              {busy === "approval" ? "Sending…" : `Approve ${quote.tokenInSymbol}`}
            </Button>
          </div>
        )}

        {/* Step 3+4 — permit signature (in-wallet) + send */}
        <Button
          onClick={confirmAndSwap}
          disabled={
            !quoteLive ||
            terminal ||
            busy !== null ||
            !walletMatches ||
            impactBlock ||
            Boolean(quote?.approvalTx && !approvalDone)
          }
          className="w-full"
        >
          {busy === "swap" ? "Waiting for wallet…" : "Confirm & swap"}
        </Button>
        <p className="text-center text-[11px] text-muted-foreground">
          Your wallet signature is the only thing that executes this trade. Review the wallet
          prompt carefully.
        </p>
      </CardContent>
    </Card>
  );
}
