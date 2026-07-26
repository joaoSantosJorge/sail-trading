import { PrivyClient } from "@privy-io/node";
import { createViemAccount } from "@privy-io/node/viem";
import { env } from "@/server/env";
import {
  SignerError,
  SignerUnavailableError,
  type ManagedSigner,
  type ManagedWallet,
  type SignerAccount,
} from "./types";

/**
 * Privy implementation of ManagedSigner. Agent keys are generated inside
 * Privy's TEE and are non-exportable; this module holds only the API
 * credentials needed to REQUEST signatures. Defense layers on top of this:
 * - PRIVY_AUTHORIZATION_KEY owner-locks wallets — Privy rejects signature
 *   requests not authorized by our key, so a leaked app secret alone is not
 *   enough to sign.
 * - PRIVY_POLICY_ID (configured in the Privy dashboard) attaches a policy
 *   denying every user-signed Hyperliquid action type that moves funds
 *   (Withdraw, UsdSend, SpotSend, ApproveAgent, ...), leaving only
 *   Exchange-domain L1 actions (orders / cancels / leverage).
 * - Hyperliquid itself: agent keys can never withdraw, and the user can
 *   revoke the agent on-chain at any time.
 */

let client: PrivyClient | null = null;

function privyClient(): PrivyClient {
  if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) throw new SignerUnavailableError();
  if (!client) {
    client = new PrivyClient({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET });
  }
  return client;
}

function authorizationContext() {
  return env.PRIVY_AUTHORIZATION_KEY
    ? { authorization_private_keys: [env.PRIVY_AUTHORIZATION_KEY] }
    : undefined;
}

export const privySigner: ManagedSigner = {
  provider: "privy",

  async createWallet(externalId: string): Promise<ManagedWallet> {
    const c = privyClient();
    const wallet = await c.wallets().create({
      chain_type: "ethereum",
      external_id: externalId,
      display_name: `sail-live agent (${externalId})`,
      ...(env.PRIVY_POLICY_ID ? { policy_ids: [env.PRIVY_POLICY_ID] } : {}),
      // Owner-lock the wallet to our authorization key (its P-256 PUBLIC
      // part) — Privy then refuses signature requests the key didn't sign.
      ...(env.PRIVY_OWNER_PUBLIC_KEY ? { owner: { public_key: env.PRIVY_OWNER_PUBLIC_KEY } } : {}),
    });
    if (!wallet.id || !wallet.address) {
      throw new SignerError("privy returned an incomplete wallet");
    }
    return { walletId: wallet.id, address: wallet.address as `0x${string}` };
  },

  getAccount(wallet: ManagedWallet): SignerAccount {
    const c = privyClient();
    const account = createViemAccount(c, {
      walletId: wallet.walletId,
      address: wallet.address,
      authorizationContext: authorizationContext(),
    });
    return account as unknown as SignerAccount;
  },
};

/** True when live signing is possible in this environment. */
export function signerConfigured(): boolean {
  return Boolean(env.PRIVY_APP_ID && env.PRIVY_APP_SECRET);
}
