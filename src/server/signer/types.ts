/**
 * Managed-signer abstraction for live algo deployments.
 *
 * Custody invariant: the app NEVER holds key material. Implementations mint
 * keys inside a provider's enclave (non-exportable) and expose only a
 * signature-request capability, so a full server compromise can at worst
 * place bad trades until credentials are revoked — never exfiltrate a key.
 * Hyperliquid agent keys additionally cannot withdraw funds by protocol.
 *
 * The interface is deliberately tiny so the provider is swappable (Privy
 * today; Turnkey would slot in behind the same two calls).
 */

/** The subset of a viem LocalAccount that Hyperliquid L1 signing needs. */
export type SignerAccount = {
  address: `0x${string}`;
  signTypedData: (typedData: unknown) => Promise<`0x${string}`>;
};

export type ManagedWallet = {
  /** Provider-side wallet id (opaque). */
  walletId: string;
  /** The agent address minted in the enclave. */
  address: `0x${string}`;
};

export interface ManagedSigner {
  /** e.g. "privy" — stored on user_signer_wallets.provider. */
  readonly provider: string;
  /** Mint a fresh enclave wallet for a user. Idempotency is the caller's
   * job (one row per user in user_signer_wallets). */
  createWallet(externalId: string): Promise<ManagedWallet>;
  /** A signing handle for an existing enclave wallet. Never returns key
   * material — every sign call round-trips to the enclave. */
  getAccount(wallet: ManagedWallet): SignerAccount;
}

export class SignerError extends Error {}

/** Thrown when live trading is requested but no signer is configured. */
export class SignerUnavailableError extends SignerError {
  constructor() {
    super("managed signer is not configured (PRIVY_APP_ID/PRIVY_APP_SECRET missing)");
  }
}
