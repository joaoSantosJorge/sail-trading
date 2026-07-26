import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/server/db";
import { userSignerWallets } from "@/server/db/schema";
import { extraAgents } from "@/server/hyperliquid/info";
import { privySigner } from "@/server/signer/privy";
import type { ManagedSigner } from "@/server/signer/types";
import type { DeploymentsDb } from "./service";

/**
 * One enclave agent wallet per user (Hyperliquid caps agents per master
 * account at ~4, so all of a user's bots share one agent named "sail-live";
 * per-bot attribution lives in bot_events, not on the venue).
 */

export const AGENT_NAME = "sail-live";
/** Re-approval prompted this long before venue-side expiry. */
export const AGENT_RENEWAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export class AgentError extends Error {}

export type SignerWalletRow = typeof userSignerWallets.$inferSelect;

/** Get-or-mint the user's enclave agent wallet. Idempotent per user. */
export async function ensureSignerWallet(
  userId: string,
  signer: ManagedSigner = privySigner,
  db: DeploymentsDb = defaultDb,
): Promise<SignerWalletRow> {
  const [existing] = await db
    .select()
    .from(userSignerWallets)
    .where(eq(userSignerWallets.userId, userId));
  if (existing) return existing;

  const wallet = await signer.createWallet(`sail-${userId}`);
  const [row] = await db
    .insert(userSignerWallets)
    .values({
      userId,
      provider: signer.provider,
      walletId: wallet.walletId,
      agentAddress: wallet.address,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  // Lost a same-instant race — the winner's row is authoritative.
  const [winner] = await db
    .select()
    .from(userSignerWallets)
    .where(eq(userSignerWallets.userId, userId));
  return winner;
}

export type AgentStatus = {
  agentAddress: string;
  /** Venue-side approval for the given master wallet. */
  approved: boolean;
  validUntil: number | null;
  /** True when approved but inside the renewal window (or expired). */
  needsRenewal: boolean;
};

/**
 * Venue truth for whether the user's agent may sign for `masterWallet`.
 * Also refreshes the stored masterWallet/validUntil columns when they drift.
 */
export async function agentStatusForWallet(
  userId: string,
  masterWallet: string,
  db: DeploymentsDb = defaultDb,
): Promise<AgentStatus | null> {
  const [row] = await db
    .select()
    .from(userSignerWallets)
    .where(eq(userSignerWallets.userId, userId));
  if (!row) return null;

  const agents = await extraAgents(masterWallet);
  const agent = agents.find((a) => a.address.toLowerCase() === row.agentAddress.toLowerCase());
  const validUntil = agent?.validUntil ?? null;
  const now = Date.now();
  const approved = validUntil !== null && validUntil > now;

  const storedMs = row.agentValidUntil?.getTime() ?? null;
  if (storedMs !== validUntil || row.masterWallet?.toLowerCase() !== masterWallet.toLowerCase()) {
    await db
      .update(userSignerWallets)
      .set({
        masterWallet: masterWallet.toLowerCase(),
        agentValidUntil: validUntil !== null ? new Date(validUntil) : null,
        updatedAt: new Date(),
      })
      .where(eq(userSignerWallets.userId, userId));
  }

  return {
    agentAddress: row.agentAddress,
    approved,
    validUntil,
    needsRenewal: validUntil === null || validUntil - now < AGENT_RENEWAL_WINDOW_MS,
  };
}

/** The signer wallet row, throwing when live signing is impossible. */
export async function requireApprovedAgent(
  userId: string,
  db: DeploymentsDb = defaultDb,
): Promise<SignerWalletRow> {
  const [row] = await db
    .select()
    .from(userSignerWallets)
    .where(eq(userSignerWallets.userId, userId));
  if (!row) throw new AgentError("no signer wallet — approve an agent first");
  const validUntil = row.agentValidUntil?.getTime() ?? null;
  if (validUntil === null || validUntil <= Date.now()) {
    throw new AgentError("agent approval missing or expired — re-approve from the app");
  }
  return row;
}
