"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Wallet } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { shortAddress } from "@/lib/utils";

/**
 * Design-system wallet controls built on ConnectButton.Custom — RainbowKit
 * keeps handling the connect/account/chain modals (themed in
 * rainbowkit-theme.ts); only the trigger buttons are ours.
 *
 * - <ConnectWalletButton/> — the full control, used on pages that need a
 *   connection (Portfolio, Trade).
 * - <WalletIndicator/> — compact top-bar status: a subtle pill showing the
 *   connected address, or a quiet icon linking to /portfolio when disconnected.
 */

export function ConnectWalletButton() {
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
        const connected = mounted && account && chain;
        return (
          // Pre-mount placeholder avoids a hydration mismatch (RainbowKit docs).
          <div
            className={mounted ? "contents" : "pointer-events-none select-none opacity-0"}
            aria-hidden={!mounted}
          >
            {!connected ? (
              <Button onClick={openConnectModal}>
                <Wallet /> Connect Wallet
              </Button>
            ) : chain.unsupported ? (
              <Button variant="destructive" onClick={openChainModal}>
                Wrong network
              </Button>
            ) : (
              <Button variant="outline" onClick={openAccountModal}>
                <span className="size-2 rounded-full bg-success" aria-hidden />
                <span className="font-mono">{shortAddress(account.address)}</span>
                <span className="text-muted-foreground">{chain.name}</span>
              </Button>
            )}
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}

export function WalletIndicator() {
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, mounted }) => {
        const connected = mounted && account && chain;
        if (!mounted) return <div className="size-7" aria-hidden />;
        if (!connected) {
          return (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Connect wallet"
                      render={<Link href="/portfolio" />}
                    >
                      <Wallet className="text-muted-foreground" />
                    </Button>
                  }
                />
                <TooltipContent side="bottom">Connect a wallet on the Portfolio page</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        }
        if (chain.unsupported) {
          return (
            <Button variant="destructive" size="xs" onClick={openChainModal}>
              Wrong network
            </Button>
          );
        }
        return (
          <Button variant="ghost" size="xs" onClick={openAccountModal}>
            <span className="size-2 rounded-full bg-success" aria-hidden />
            <span className="font-mono text-xs">{shortAddress(account.address)}</span>
          </Button>
        );
      }}
    </ConnectButton.Custom>
  );
}
