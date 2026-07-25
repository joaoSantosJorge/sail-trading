"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatBtc, formatUsd, usdToBtc } from "@/lib/portfolio/value";
import { shortAddress } from "@/lib/utils";
import type { HistoryItem, PerpPosition, Position } from "@/server/portfolio/types";
import { Badge } from "@/components/ui/badge";
import { HistoryTable } from "./history-table";
import { PerpPositionsTable } from "./perp-positions-table";
import { PositionsTable } from "./positions-table";

export type WalletData = {
  address: string;
  chain: string;
  label: string | null;
  lastSyncedAt: string | null;
  positions: Position[];
  perps: PerpPosition[];
  totalUsd: number;
  history: HistoryItem[];
};

export function WalletCard({
  wallet,
  btcUsd,
  alchemyConfigured,
}: {
  wallet: WalletData;
  btcUsd: number | null;
  alchemyConfigured: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"sync" | "remove" | null>(null);

  async function call(
    path: string,
    init: RequestInit,
    okMsg: string | ((data: unknown) => string),
  ) {
    try {
      const res = await fetch(path, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      toast.success(typeof okMsg === "function" ? okMsg(data) : okMsg);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "request failed");
    } finally {
      setBusy(null);
    }
  }

  const totalBtc = usdToBtc(wallet.totalUsd, btcUsd);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="font-mono text-base">
            {wallet.label ? (
              <>
                {wallet.label}{" "}
                <span className="font-normal text-muted-foreground">
                  {shortAddress(wallet.address)}
                </span>
              </>
            ) : (
              shortAddress(wallet.address)
            )}
            {wallet.chain !== "evm" && (
              <Badge variant="outline" className="ml-2 align-middle text-xs capitalize">
                {wallet.chain}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            {wallet.lastSyncedAt
              ? `Synced ${new Date(wallet.lastSyncedAt).toLocaleString()} · ${formatUsd(
                  wallet.totalUsd,
                )}${totalBtc !== null ? ` · ${formatBtc(totalBtc)}` : ""}`
              : "Never synced"}
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || (wallet.chain === "evm" && !alchemyConfigured)}
            onClick={() => {
              setBusy("sync");
              void call(`/api/v1/wallets/${wallet.address}/sync`, { method: "POST" }, (d) => {
                const positions = (d as { data?: { positions?: unknown[] } }).data?.positions;
                return positions?.length === 0
                  ? "Synced — wallet appears empty on all supported chains"
                  : "Holdings + history synced";
              });
            }}
          >
            {busy === "sync" ? "Syncing…" : "Sync"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            disabled={busy !== null}
            onClick={() => {
              setBusy("remove");
              void call(`/api/v1/wallets/${wallet.address}`, { method: "DELETE" }, "Wallet removed");
            }}
          >
            Remove
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="assets">
          <TabsList>
            <TabsTrigger value="assets">Assets</TabsTrigger>
            {wallet.perps.length > 0 && <TabsTrigger value="perps">Perps</TabsTrigger>}
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
          <TabsContent value="assets">
            {wallet.positions.length > 0 ? (
              <PositionsTable positions={wallet.positions} btcUsd={btcUsd} />
            ) : (
              <p className="p-4 text-center text-sm text-muted-foreground">
                {wallet.lastSyncedAt
                  ? "Wallet appears empty — the last sync found no holdings on any supported chain."
                  : "No positions yet — sync the wallet to fetch holdings."}
              </p>
            )}
          </TabsContent>
          {wallet.perps.length > 0 && (
            <TabsContent value="perps">
              <PerpPositionsTable perps={wallet.perps} />
            </TabsContent>
          )}
          <TabsContent value="history">
            <HistoryTable
              address={wallet.address}
              initialItems={wallet.history}
              synced={wallet.lastSyncedAt !== null}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
