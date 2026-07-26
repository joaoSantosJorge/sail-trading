import { signL1Action } from "@nktkas/hyperliquid/signing";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/**
 * BROWSER-ONLY agent-wallet management for Hyperliquid perps trading. The
 * agent private key is generated here, lives in sessionStorage, and is NEVER
 * sent anywhere — the server relays only signed payloads. Agent keys are
 * trade-only by protocol design (they cannot withdraw), and dying with the
 * tab is deliberate: re-approval is a single wallet signature.
 *
 * Import this from "use client" components only.
 */

export type AgentKey = { privateKey: `0x${string}`; address: `0x${string}`; name: string };

const storageKey = (wallet: string, isTestnet: boolean) =>
  `hl-agent:${isTestnet ? "testnet" : "mainnet"}:${wallet.toLowerCase()}`;

/** Load the tab's agent key for a wallet, or mint a fresh one. */
export function getOrCreateAgentKey(wallet: string, isTestnet: boolean): AgentKey {
  const key = storageKey(wallet, isTestnet);
  const raw = window.sessionStorage.getItem(key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as AgentKey;
      if (parsed.privateKey && parsed.address) return parsed;
    } catch {
      // fall through to regeneration
    }
  }
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const agent: AgentKey = {
    privateKey,
    address: account.address,
    name: `sail-${account.address.slice(2, 8)}`,
  };
  window.sessionStorage.setItem(key, JSON.stringify(agent));
  return agent;
}

export function clearAgentKey(wallet: string, isTestnet: boolean): void {
  window.sessionStorage.removeItem(storageKey(wallet, isTestnet));
}

/**
 * EIP-712 payload for the one-time approveAgent signature by the user's MAIN
 * wallet (plain typed data — signable with wagmi's signTypedData), plus the
 * action object the relay posts to the venue.
 */
export function buildApproveAgent(agent: AgentKey, isTestnet: boolean) {
  return buildApproveAgentFor(agent.address, agent.name, isTestnet);
}

/**
 * Same payload for an agent the browser does NOT hold the key for — used by
 * the live-deployments flow, where the agent key lives in a server-side
 * enclave and only its ADDRESS is known here.
 */
export function buildApproveAgentFor(
  agentAddress: `0x${string}`,
  agentName: string,
  isTestnet: boolean,
) {
  const nonce = Date.now();
  const action = {
    type: "approveAgent" as const,
    signatureChainId: "0xa4b1", // Arbitrum — the wallet's signing domain, unrelated to funds
    hyperliquidChain: isTestnet ? ("Testnet" as const) : ("Mainnet" as const),
    agentAddress,
    agentName,
    nonce,
  };
  return {
    action,
    nonce,
    typedData: {
      domain: {
        name: "HyperliquidSignTransaction",
        version: "1",
        chainId: 42161,
        verifyingContract: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      },
      types: {
        "HyperliquidTransaction:ApproveAgent": [
          { name: "hyperliquidChain", type: "string" },
          { name: "agentAddress", type: "address" },
          { name: "agentName", type: "string" },
          { name: "nonce", type: "uint64" },
        ],
      },
      primaryType: "HyperliquidTransaction:ApproveAgent" as const,
      message: {
        hyperliquidChain: action.hyperliquidChain,
        agentAddress,
        agentName,
        nonce: BigInt(nonce),
      },
    },
  };
}

/** Split a hex wallet signature into the {r,s,v} shape the venue expects. */
export function splitSignature(hex: `0x${string}`): { r: string; s: string; v: number } {
  const r = `0x${hex.slice(2, 66)}`;
  const s = `0x${hex.slice(66, 130)}`;
  let v = parseInt(hex.slice(130, 132), 16);
  if (v < 27) v += 27;
  return { r, s, v };
}

/**
 * Sign a server-minted L1 action (order / updateLeverage) with the agent key.
 * The action object is signed VERBATIM — key order comes from the server and
 * must not be touched, or the action hash (msgpack of the exact structure)
 * won't match what the venue computes.
 */
export async function signAgentAction(
  agent: AgentKey,
  action: Record<string, unknown>,
  isTestnet: boolean,
): Promise<{ action: Record<string, unknown>; signature: { r: string; s: string; v: number }; nonce: number }> {
  const nonce = Date.now();
  const wallet = privateKeyToAccount(agent.privateKey);
  const signature = await signL1Action({ wallet, action, nonce, isTestnet });
  return { action, signature: { r: signature.r, s: signature.s, v: signature.v }, nonce };
}
