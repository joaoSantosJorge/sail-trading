"use client";

import { SidebarTrigger } from "@/components/ui/sidebar";
import { WalletIndicator } from "./connect-wallet-button";

/**
 * Persistent app header, rendered inside the Web3 context. The full connect
 * button lives on the Wallets page; here only a compact indicator shows which
 * wallet is connected (top-right, the conventional dapp position). The mobile
 * sidebar trigger sits on the left since the sidebar itself is off-canvas
 * below md.
 */
export function AppTopBar() {
  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur">
      <SidebarTrigger className="md:hidden" />
      <div className="ml-auto">
        <WalletIndicator />
      </div>
    </header>
  );
}
