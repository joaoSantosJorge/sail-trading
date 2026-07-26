"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

type PerpWallet = { address: string; label: string | null };
type Market = { coin: string; szDecimals: number; maxLeverage: number; markPx: number };
type SwapPosition = {
  chainId: number;
  symbol: string;
  tokenAddress: string | null;
  balance: string;
  priceUsd: number | null;
};
type SwapWallet = { address: string; label: string | null; positions: SwapPosition[] };

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm disabled:opacity-50";

function walletLabel(w: { address: string; label: string | null }): string {
  const short = `${w.address.slice(0, 8)}…${w.address.slice(-4)}`;
  return w.label ? `${w.label} (${short})` : short;
}

function trimZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

/** Manual proposal form. Client checks are hints only — the server clamp decides. */
export function NewTradeForm({
  perpWallets,
  markets,
  maxLeverage,
  swapWallets,
  chains,
  knownTokens,
}: {
  perpWallets: PerpWallet[];
  markets: Market[];
  maxLeverage: number;
  swapWallets: SwapWallet[];
  chains: { chainId: number; name: string }[];
  knownTokens: Record<number, string[]>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      toast.success("Proposal created");
      router.push(data.data.targetPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
      setBusy(false);
    }
  }

  return (
    <Tabs defaultValue="perp">
      <TabsList>
        <TabsTrigger value="perp">Perp (Hyperliquid)</TabsTrigger>
        <TabsTrigger value="swap">Swap (Uniswap)</TabsTrigger>
      </TabsList>
      <TabsContent value="perp">
        <PerpForm
          wallets={perpWallets}
          markets={markets}
          maxLeverage={maxLeverage}
          busy={busy}
          onSubmit={submit}
        />
      </TabsContent>
      <TabsContent value="swap">
        <SwapForm
          wallets={swapWallets}
          chains={chains}
          knownTokens={knownTokens}
          busy={busy}
          onSubmit={submit}
        />
      </TabsContent>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </Tabs>
  );
}

function PerpForm({
  wallets,
  markets,
  maxLeverage,
  busy,
  onSubmit,
}: {
  wallets: PerpWallet[];
  markets: Market[];
  maxLeverage: number;
  busy: boolean;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const [wallet, setWallet] = useState(wallets[0]?.address ?? "");
  const [coin, setCoin] = useState("");
  const [side, setSide] = useState<"long" | "short">("long");
  const [sizeInput, setSizeInput] = useState("");
  const [unit, setUnit] = useState<"coin" | "usd">("usd");
  const [leverage, setLeverage] = useState("1");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [limitPx, setLimitPx] = useState("");
  const [tif, setTif] = useState<"Gtc" | "Ioc">("Gtc");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [note, setNote] = useState("");

  const market = markets.find((m) => m.coin === coin) ?? null;
  const levCap = market ? Math.min(market.maxLeverage, maxLeverage) : maxLeverage;

  const refPx = useMemo(() => {
    if (!market) return null;
    if (orderType === "limit") {
      const px = Number(limitPx);
      return Number.isFinite(px) && px > 0 ? px : null;
    }
    return market.markPx;
  }, [market, orderType, limitPx]);

  // Size always submits in coin units; the USD unit is a convenience view.
  const sizeCoin = useMemo(() => {
    const n = Number(sizeInput);
    if (!market || !Number.isFinite(n) || n <= 0 || refPx === null) return null;
    const coins = unit === "usd" ? n / refPx : n;
    return trimZeros(coins.toFixed(market.szDecimals));
  }, [sizeInput, unit, market, refPx]);
  const notional = sizeCoin !== null && refPx !== null ? Number(sizeCoin) * refPx : null;

  // Fail-fast hints mirroring the server clamp (which stays authoritative).
  const slNum = Number(stopLoss);
  const tpNum = Number(takeProfit);
  const slHint =
    stopLoss && refPx !== null && Number.isFinite(slNum)
      ? side === "long" && slNum >= refPx
        ? "must be below the entry price for a long"
        : side === "short" && slNum <= refPx
          ? "must be above the entry price for a short"
          : null
      : null;
  const tpHint =
    takeProfit && refPx !== null && Number.isFinite(tpNum)
      ? side === "long" && tpNum <= refPx
        ? "must be above the entry price for a long"
        : side === "short" && tpNum >= refPx
          ? "must be below the entry price for a short"
          : null
      : null;

  const canSubmit =
    !busy &&
    wallet !== "" &&
    market !== null &&
    sizeCoin !== null &&
    notional !== null &&
    (orderType === "market" || refPx !== null) &&
    slHint === null &&
    tpHint === null;

  if (wallets.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        No Hyperliquid wallet registered. Add one on the Portfolio page (chain
        &ldquo;Hyperliquid&rdquo;) and sync it first.
      </p>
    );
  }
  if (markets.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        Could not load Hyperliquid markets — try reloading the page.
      </p>
    );
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit || sizeCoin === null || notional === null) return;
        onSubmit({
          kind: "perp",
          walletAddress: wallet,
          coin,
          side,
          size: sizeCoin,
          leverage: Number(leverage) || 1,
          orderType,
          ...(orderType === "limit" ? { limitPx: Number(limitPx), tif } : {}),
          reduceOnly,
          ...(stopLoss && !reduceOnly ? { stopLossPx: Number(stopLoss) } : {}),
          ...(takeProfit && !reduceOnly ? { takeProfitPx: Number(takeProfit) } : {}),
          sizeUsd: notional,
          ...(note.trim() ? { note: note.trim() } : {}),
        });
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="perp-wallet">Wallet</Label>
          <select
            id="perp-wallet"
            className={selectClass}
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
          >
            {wallets.map((w) => (
              <option key={w.address} value={w.address}>
                {walletLabel(w)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="perp-coin">Market</Label>
          <select
            id="perp-coin"
            className={selectClass}
            value={coin}
            onChange={(e) => setCoin(e.target.value)}
          >
            <option value="" disabled>
              Select a market…
            </option>
            {markets.map((m) => (
              <option key={m.coin} value={m.coin}>
                {m.coin}-PERP · {m.markPx}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <Label>Side</Label>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant={side === "long" ? "default" : "outline"}
              onClick={() => setSide("long")}
            >
              Long
            </Button>
            <Button
              type="button"
              size="sm"
              variant={side === "short" ? "default" : "outline"}
              onClick={() => setSide("short")}
            >
              Short
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="perp-lev">Leverage (max {levCap}x)</Label>
          <Input
            id="perp-lev"
            type="number"
            min={1}
            max={levCap}
            step={1}
            value={leverage}
            onChange={(e) => setLeverage(e.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="perp-size">Size</Label>
          <div className="flex gap-2">
            <Input
              id="perp-size"
              inputMode="decimal"
              placeholder={unit === "usd" ? "USD notional" : `${coin || "coin"} units`}
              value={sizeInput}
              onChange={(e) => setSizeInput(e.target.value)}
            />
            <select
              aria-label="Size unit"
              className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
              value={unit}
              onChange={(e) => setUnit(e.target.value as "coin" | "usd")}
            >
              <option value="usd">USD</option>
              <option value="coin">{coin || "coin"}</option>
            </select>
          </div>
          {sizeCoin !== null && market && (
            <p className="text-xs text-muted-foreground">
              = {sizeCoin} {market.coin}
              {notional !== null &&
                ` · ~$${notional.toFixed(2)} notional · ~$${(notional / (Number(leverage) || 1)).toFixed(2)} margin`}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="perp-type">Entry</Label>
          <div className="flex gap-2">
            <select
              id="perp-type"
              className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
              value={orderType}
              onChange={(e) => setOrderType(e.target.value as "market" | "limit")}
            >
              <option value="market">Market</option>
              <option value="limit">Limit</option>
            </select>
            {orderType === "limit" && (
              <>
                <Input
                  aria-label="Limit price"
                  inputMode="decimal"
                  placeholder={market ? `price (mark ${market.markPx})` : "price"}
                  value={limitPx}
                  onChange={(e) => setLimitPx(e.target.value)}
                />
                <select
                  aria-label="Time in force"
                  className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                  value={tif}
                  onChange={(e) => setTif(e.target.value as "Gtc" | "Ioc")}
                >
                  <option value="Gtc">GTC</option>
                  <option value="Ioc">IOC</option>
                </select>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="perp-sl">Stop loss (price, optional)</Label>
          <Input
            id="perp-sl"
            inputMode="decimal"
            disabled={reduceOnly}
            value={stopLoss}
            onChange={(e) => setStopLoss(e.target.value)}
          />
          {slHint && <p className="text-xs text-destructive">{slHint}</p>}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="perp-tp">Take profit (price, optional)</Label>
          <Input
            id="perp-tp"
            inputMode="decimal"
            disabled={reduceOnly}
            value={takeProfit}
            onChange={(e) => setTakeProfit(e.target.value)}
          />
          {tpHint && <p className="text-xs text-destructive">{tpHint}</p>}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Switch id="perp-reduce" checked={reduceOnly} onCheckedChange={setReduceOnly} />
        <Label htmlFor="perp-reduce">Reduce only (close an existing position — no SL/TP)</Label>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="perp-note">Note (optional)</Label>
        <Textarea
          id="perp-note"
          rows={2}
          maxLength={2000}
          placeholder="Why this trade?"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      <Button type="submit" disabled={!canSubmit}>
        {busy ? "Creating…" : "Create proposal"}
      </Button>
    </form>
  );
}

function SwapForm({
  wallets,
  chains,
  knownTokens,
  busy,
  onSubmit,
}: {
  wallets: SwapWallet[];
  chains: { chainId: number; name: string }[];
  knownTokens: Record<number, string[]>;
  busy: boolean;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const [wallet, setWallet] = useState(wallets[0]?.address ?? "");
  const [chainId, setChainId] = useState(chains[0]?.chainId ?? 8453);
  const [tokenIn, setTokenIn] = useState("");
  const [tokenOut, setTokenOut] = useState("");
  const [amountIn, setAmountIn] = useState("");
  const [slippageBps, setSlippageBps] = useState("50");
  const [usdOverride, setUsdOverride] = useState("");
  const [note, setNote] = useState("");

  const positions = useMemo(
    () =>
      (wallets.find((w) => w.address === wallet)?.positions ?? []).filter(
        (p) => p.chainId === chainId && Number(p.balance) > 0,
      ),
    [wallets, wallet, chainId],
  );
  const held = positions.find((p) => p.symbol === tokenIn) ?? null;
  const outOptions = (knownTokens[chainId] ?? []).filter((s) => s !== tokenIn);

  const sizeUsd = useMemo(() => {
    const amount = Number(amountIn);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (held?.priceUsd != null) return amount * held.priceUsd;
    const manual = Number(usdOverride);
    return Number.isFinite(manual) && manual > 0 ? manual : null;
  }, [amountIn, held, usdOverride]);

  const canSubmit =
    !busy && wallet !== "" && held !== null && tokenOut !== "" && sizeUsd !== null;

  if (wallets.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        No EVM wallet registered. Add one on the Portfolio page and sync it first.
      </p>
    );
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit || sizeUsd === null) return;
        onSubmit({
          kind: "swap",
          chainId,
          walletAddress: wallet,
          tokenIn,
          tokenOut,
          amountIn,
          sizeUsd,
          maxSlippageBps: Math.min(Math.max(Number(slippageBps) || 50, 1), 100),
          ...(note.trim() ? { note: note.trim() } : {}),
        });
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="swap-wallet">Wallet</Label>
          <select
            id="swap-wallet"
            className={selectClass}
            value={wallet}
            onChange={(e) => {
              setWallet(e.target.value);
              setTokenIn("");
            }}
          >
            {wallets.map((w) => (
              <option key={w.address} value={w.address}>
                {walletLabel(w)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="swap-chain">Chain</Label>
          <select
            id="swap-chain"
            className={selectClass}
            value={chainId}
            onChange={(e) => {
              setChainId(Number(e.target.value));
              setTokenIn("");
              setTokenOut("");
            }}
          >
            {chains.map((c) => (
              <option key={c.chainId} value={c.chainId}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="swap-in">Sell</Label>
          <select
            id="swap-in"
            className={selectClass}
            value={tokenIn}
            onChange={(e) => setTokenIn(e.target.value)}
          >
            <option value="" disabled>
              {positions.length ? "Select a held token…" : "No holdings on this chain"}
            </option>
            {positions.map((p) => (
              <option key={`${p.symbol}-${p.tokenAddress ?? "native"}`} value={p.symbol}>
                {p.symbol} · balance {p.balance}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="swap-out">Buy</Label>
          <select
            id="swap-out"
            className={selectClass}
            value={tokenOut}
            onChange={(e) => setTokenOut(e.target.value)}
          >
            <option value="" disabled>
              Select a token…
            </option>
            {outOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="swap-amount">Amount</Label>
          <div className="flex gap-2">
            <Input
              id="swap-amount"
              inputMode="decimal"
              placeholder={tokenIn ? `${tokenIn} amount` : "amount"}
              value={amountIn}
              onChange={(e) => setAmountIn(e.target.value)}
            />
            {held && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setAmountIn(held.balance)}
              >
                Max
              </Button>
            )}
          </div>
          {sizeUsd !== null && (
            <p className="text-xs text-muted-foreground">~${sizeUsd.toFixed(2)}</p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="swap-slip">Max slippage (bps)</Label>
          <Input
            id="swap-slip"
            type="number"
            min={1}
            max={100}
            value={slippageBps}
            onChange={(e) => setSlippageBps(e.target.value)}
          />
        </div>
      </div>

      {held !== null && held.priceUsd == null && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="swap-usd">Estimated USD value (no snapshot price for {tokenIn})</Label>
          <Input
            id="swap-usd"
            inputMode="decimal"
            value={usdOverride}
            onChange={(e) => setUsdOverride(e.target.value)}
          />
        </div>
      )}

      <div className="flex flex-col gap-1">
        <Label htmlFor="swap-note">Note (optional)</Label>
        <Textarea
          id="swap-note"
          rows={2}
          maxLength={2000}
          placeholder="Why this trade?"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      <Button type="submit" disabled={!canSubmit}>
        {busy ? "Creating…" : "Create proposal"}
      </Button>
    </form>
  );
}
