import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  metaMaskWallet,
  phantomWallet,
  rainbowWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { cookieStorage, createStorage } from "wagmi";
import { arbitrum, base, mainnet } from "wagmi/chains";

// WalletConnect project id enables the QR/mobile flow; without it, injected
// browser wallets (MetaMask etc.) still work. Get one at cloud.reown.com.
// `||` (not ??) below: an empty-string placeholder in .env.local must fall
// back the same as an unset variable.
export const walletConnectConfigured = Boolean(
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
);

export const wagmiConfig = getDefaultConfig({
  appName: "Research Trading Platform",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "unset-project-id",
  chains: [mainnet, base, arbitrum],
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
  // RainbowKit's default list (rainbow/coinbase/metamask/walletconnect) plus
  // Phantom, which is not a default. NOTE: this connects Phantom's EVM side;
  // Solana holdings need the future solana portfolio adapter.
  wallets: [
    {
      groupName: "Popular",
      wallets: [phantomWallet, metaMaskWallet, rainbowWallet, coinbaseWallet, walletConnectWallet],
    },
  ],
});
