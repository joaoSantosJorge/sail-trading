"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { useAccount } from "wagmi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConnectWalletButton } from "@/components/web3/connect-wallet-button";
import { shortAddress } from "@/lib/utils";
import { WalletCard, type WalletData } from "./wallet-card";

export function WalletsPanel({
  wallets,
  alchemyConfigured,
  btcUsd,
}: {
  wallets: WalletData[];
  alchemyConfigured: boolean;
  btcUsd: number | null;
}) {
  const router = useRouter();
  const { address: connected } = useAccount();
  const [busy, setBusy] = useState(false);
  const [watchAddress, setWatchAddress] = useState("");
  const [watchLabel, setWatchLabel] = useState("");
  const [watchChain, setWatchChain] = useState<"evm" | "hyperliquid">("evm");

  const connectedRegistered =
    !!connected && wallets.some((w) => w.address === connected.toLowerCase());

  async function register(address: string, label?: string, chain?: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/v1/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address,
          ...(label ? { label } : {}),
          ...(chain ? { chain } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      toast.success("Wallet registered — now sync it");
      setWatchAddress("");
      setWatchLabel("");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <ConnectWalletButton />
        {!connected ? (
          <p className="text-sm text-muted-foreground">
            Connect a wallet, then track it here.
          </p>
        ) : connectedRegistered ? (
          <p className="text-sm text-muted-foreground">
            {shortAddress(connected)} is tracked — sync it below to refresh holdings.
          </p>
        ) : (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => register(connected)}>
            {busy ? "Registering…" : `Track ${shortAddress(connected)}`}
          </Button>
        )}
      </div>

      {/* Watch-only: track any address without connecting it. */}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (watchAddress.trim())
            void register(watchAddress.trim(), watchLabel.trim() || undefined, watchChain);
        }}
      >
        <Input
          value={watchAddress}
          onChange={(e) => setWatchAddress(e.target.value)}
          placeholder="0x… watch any address"
          className="w-72 font-mono text-xs"
        />
        <Input
          value={watchLabel}
          onChange={(e) => setWatchLabel(e.target.value)}
          placeholder="Label (optional)"
          className="w-40"
          maxLength={60}
        />
        {/* Same 0x address either reads EVM chains via Alchemy or the
            Hyperliquid venue via its info API — the user picks the ecosystem. */}
        <select
          value={watchChain}
          onChange={(e) => setWatchChain(e.target.value as "evm" | "hyperliquid")}
          className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
          aria-label="Chain ecosystem"
        >
          <option value="evm">EVM chains</option>
          <option value="hyperliquid">Hyperliquid</option>
        </select>
        <Button type="submit" size="sm" variant="outline" disabled={busy || !watchAddress.trim()}>
          Watch
        </Button>
      </form>

      {!alchemyConfigured && (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground">
          ALCHEMY_API_KEY is not set — holdings sync is disabled until it is added to .env.local.
        </p>
      )}

      {wallets.length === 0 && (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No wallets tracked yet. Connect a wallet or watch any address, then sync its holdings.
        </div>
      )}

      {wallets.map((w) => (
        <WalletCard
          key={w.address}
          wallet={w}
          btcUsd={btcUsd}
          alchemyConfigured={alchemyConfigured}
        />
      ))}
    </div>
  );
}
