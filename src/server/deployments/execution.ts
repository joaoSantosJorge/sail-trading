import { createHash } from "node:crypto";
import { signL1Action } from "@nktkas/hyperliquid/signing";
import { formatPx, formatSz } from "@/lib/hyperliquid/format";
import {
  clearinghouseState,
  hyperliquidIsTestnet,
  metaAndAssetCtxs,
  orderStatus,
  relayExchangeAction,
} from "@/server/hyperliquid/info";
import { clampPerpProposal, type PerpAccountLike, type PerpCaps } from "@/server/trade/perpProposals";
import { buildPerpOrderAction } from "@/server/trade/perpOrder";
import { privySigner } from "@/server/signer/privy";
import type { ManagedSigner, SignerAccount } from "@/server/signer/types";
import type { StrategyDSL } from "@/server/engine/types";
import { requireApprovedAgent, type SignerWalletRow } from "./agents";
import { checkAggregateExposure, existingBotNotional } from "./risk";
import type { DeploymentRow } from "./service";

/**
 * Live order execution for deployments: the ONLY place bot orders are signed.
 * Every entry goes through the same PURE clampPerpProposal as human trades,
 * PLUS the aggregate-exposure cap, before a signature is ever requested from
 * the enclave. Orders carry a deterministic cloid derived from
 * (deploymentId, barT, intent) so a crash between relay and DB write is
 * recoverable and a retry can never double-fill.
 */

export class ExecutionError extends Error {}

function caps(): PerpCaps {
  return {
    maxUsd: Number(process.env.MAX_PROPOSAL_USD) || 1000,
    maxPct: Number(process.env.MAX_PROPOSAL_PCT) || 25,
    maxLeverage: Number(process.env.MAX_PERP_LEVERAGE) || 5,
  };
}

/** Default IOC slippage for bot market orders, bps. */
const BOT_SLIPPAGE_BPS = 50;
const CONFIRM_POLLS = 5;
const CONFIRM_POLL_MS = 2000;

/** Deterministic 128-bit client order id: 0x + 32 hex chars. */
export function makeCloid(deploymentId: number, barT: number, intent: "entry" | "exit"): `0x${string}` {
  const digest = createHash("sha256")
    .update(`sail:${deploymentId}:${barT}:${intent}`)
    .digest("hex");
  return `0x${digest.slice(0, 32)}` as `0x${string}`;
}

/**
 * Serialize signing per user: Hyperliquid nonces are per-agent timestamps,
 * and one user's bots share one agent key — concurrent Date.now() nonces
 * would collide or arrive out of order.
 */
const userLocks = new Map<string, Promise<unknown>>();
export function withUserSigningLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run after the previous holder, pass or fail
  userLocks.set(
    userId,
    next.catch(() => {}), // the chain itself must never reject
  );
  return next;
}

export type VenueContext = {
  account: PerpAccountLike;
  assetIndex: number;
  szDecimals: number;
  maxLeverage: number;
  markPx: number;
};

/** Live venue + account facts for one coin/wallet, straight from the venue. */
export async function loadVenueContext(walletAddress: string, coin: string): Promise<VenueContext> {
  const [meta, ctxs] = await metaAndAssetCtxs();
  const assetIndex = meta.universe.findIndex((u) => u.name === coin);
  if (assetIndex < 0) throw new ExecutionError(`market ${coin} not found on venue`);
  const markPx = Number(ctxs[assetIndex]?.markPx ?? 0);
  if (!Number.isFinite(markPx) || markPx <= 0) throw new ExecutionError("no live mark price");

  const ch = await clearinghouseState(walletAddress);
  const account: PerpAccountLike = {
    address: walletAddress.toLowerCase(),
    accountValue: Number(ch.marginSummary.accountValue),
    totalMarginUsed: Number(ch.marginSummary.totalMarginUsed),
    positions: ch.assetPositions.map((p) => ({
      coin: p.position.coin,
      side: Number(p.position.szi) >= 0 ? ("long" as const) : ("short" as const),
      size: Math.abs(Number(p.position.szi)),
    })),
  };
  return {
    account,
    assetIndex,
    szDecimals: meta.universe[assetIndex].szDecimals,
    maxLeverage: meta.universe[assetIndex].maxLeverage,
    markPx,
  };
}

export type OrderOutcome = {
  oid: number | null;
  cloid: string;
  filled: boolean;
  avgPx: number | null;
  totalSz: number | null;
  /** Resting TP/SL trigger order ids, [tpOid, slOid] order not guaranteed. */
  triggerOids: number[];
  triggerErrors: string[];
};

type SignAndRelayDeps = {
  signer: ManagedSigner;
  relay: typeof relayExchangeAction;
  pollStatus: typeof orderStatus;
  isTestnet: boolean;
  now: () => number;
};

const defaultDeps = (): SignAndRelayDeps => ({
  signer: privySigner,
  relay: relayExchangeAction,
  pollStatus: orderStatus,
  isTestnet: hyperliquidIsTestnet(),
  now: () => Date.now(),
});

async function signAndRelay(
  account: SignerAccount,
  action: Record<string, unknown>,
  deps: SignAndRelayDeps,
): Promise<Record<string, unknown>> {
  const nonce = deps.now();
  const signature = await signL1Action({
    wallet: account as Parameters<typeof signL1Action>[0]["wallet"],
    action,
    nonce,
    isTestnet: deps.isTestnet,
  });
  return deps.relay({
    action,
    signature: { r: signature.r, s: signature.s, v: signature.v },
    nonce,
  });
}

/** Exported for tests: exchange responses → one OrderOutcome. */
export function parseOrderResponse(res: Record<string, unknown>, cloid: string): OrderOutcome {
  const statuses =
    (res as { response?: { data?: { statuses?: unknown[] } } }).response?.data?.statuses ?? [];
  const status = statuses[0];
  if (
    (res as { status?: string }).status !== "ok" ||
    status === undefined ||
    (typeof status === "object" && status !== null && "error" in status)
  ) {
    const reason =
      typeof status === "object" && status !== null && "error" in status
        ? String((status as { error: unknown }).error)
        : JSON.stringify(res).slice(0, 200);
    throw new ExecutionError(`order rejected: ${reason}`);
  }

  const triggerOids: number[] = [];
  const triggerErrors: string[] = [];
  for (const t of statuses.slice(1)) {
    if (typeof t === "object" && t !== null && "resting" in t) {
      triggerOids.push((t as { resting: { oid: number } }).resting.oid);
    } else if (typeof t === "object" && t !== null && "error" in t) {
      triggerErrors.push(String((t as { error: unknown }).error));
    }
  }

  if (typeof status === "object" && status !== null && "filled" in status) {
    const f = (status as { filled: { oid: number; totalSz: string; avgPx: string } }).filled;
    return {
      oid: f.oid,
      cloid,
      filled: true,
      avgPx: Number(f.avgPx),
      totalSz: Number(f.totalSz),
      triggerOids,
      triggerErrors,
    };
  }
  if (typeof status === "object" && status !== null && "resting" in status) {
    return {
      oid: (status as { resting: { oid: number } }).resting.oid,
      cloid,
      filled: false,
      avgPx: null,
      totalSz: null,
      triggerOids,
      triggerErrors,
    };
  }
  throw new ExecutionError(`unrecognized order status: ${JSON.stringify(status).slice(0, 120)}`);
}

export type LiveEntryInput = {
  deployment: DeploymentRow;
  dsl: StrategyDSL;
  barT: number;
  /** Precomputed by the tick from live account value + sizing config. */
  notionalUsd: number;
};

/**
 * Place a live entry: clamp → aggregate cap → build wire action (entry +
 * venue-side TP/SL triggers from dsl.risk) → updateLeverage → sign in the
 * enclave → relay → confirm.
 */
export async function executeLiveEntry(
  input: LiveEntryInput,
  deps: SignAndRelayDeps = defaultDeps(),
  agentRow?: SignerWalletRow,
): Promise<OrderOutcome> {
  const { deployment, dsl, barT } = input;
  const walletAddress = deployment.walletAddress;
  if (!walletAddress) throw new ExecutionError("deployment has no wallet address");
  const coin = await requireCoin(deployment);
  const agent = agentRow ?? (await requireApprovedAgent(deployment.userId));

  const venue = await loadVenueContext(walletAddress, coin);
  const side = dsl.direction === "short" ? ("short" as const) : ("long" as const);
  const sign = side === "short" ? -1 : 1;

  const size = input.notionalUsd / venue.markPx;
  const stopLossPx =
    dsl.risk.stopLossPct !== undefined
      ? Number(formatPx(venue.markPx * (1 - (sign * dsl.risk.stopLossPct) / 100), venue.szDecimals))
      : undefined;
  const takeProfitPx =
    dsl.risk.takeProfitPct !== undefined
      ? Number(formatPx(venue.markPx * (1 + (sign * dsl.risk.takeProfitPct) / 100), venue.szDecimals))
      : undefined;

  // The SAME pure clamp human trades go through — never bypassed.
  const validated = clampPerpProposal(
    {
      walletAddress,
      coin,
      side,
      size: formatSz(size, venue.szDecimals),
      leverage: deployment.leverage,
      orderType: "market",
      reduceOnly: false,
      stopLossPx,
      takeProfitPx,
      sizeUsd: input.notionalUsd,
      maxSlippageBps: BOT_SLIPPAGE_BPS,
      rationale: `deployment #${deployment.id}: DSL entry signal on bar ${barT}`,
      risks: ["automated execution"],
      confidence: "medium",
      invalidation: "DSL exit signal, stop-loss, or kill switch",
    },
    [venue.account],
    [{ coin, szDecimals: venue.szDecimals, maxLeverage: venue.maxLeverage, markPx: venue.markPx }],
    caps(),
  );

  // Aggregate cap across all of this user's live bots.
  const existing = await existingBotNotional(deployment.userId, deployment.id);
  checkAggregateExposure({
    newNotionalUsd: validated.notionalUsd,
    accountValueUsd: venue.account.accountValue,
    existingBotNotionalUsd: existing,
  });

  const px = formatPx(
    venue.markPx * (side === "long" ? 1 + BOT_SLIPPAGE_BPS / 10_000 : 1 - BOT_SLIPPAGE_BPS / 10_000),
    venue.szDecimals,
  );
  const cloid = makeCloid(deployment.id, barT, "entry");
  const { orderAction } = buildPerpOrderAction(validated, venue.assetIndex, px);
  // Stamp the deterministic cloid on the ENTRY order only.
  (orderAction.orders[0] as Record<string, unknown>).c = cloid;

  const account = deps.signer.getAccount({ walletId: agent.walletId, address: agent.agentAddress as `0x${string}` });

  return withUserSigningLock(deployment.userId, async () => {
    const leverageRes = await signAndRelay(
      account,
      { type: "updateLeverage", asset: venue.assetIndex, isCross: true, leverage: validated.leverage },
      deps,
    );
    if ((leverageRes as { status?: string }).status !== "ok") {
      throw new ExecutionError(`leverage update rejected: ${JSON.stringify(leverageRes).slice(0, 150)}`);
    }
    const res = await signAndRelay(account, orderAction, deps);
    let outcome = parseOrderResponse(res, cloid);
    outcome = await confirmIfResting(outcome, walletAddress, deps);
    return outcome;
  });
}

/**
 * Close a live position: cancel resting TP/SL triggers, then reduce-only
 * IOC market order for the full expected size.
 */
export async function executeLiveClose(
  deployment: DeploymentRow,
  barT: number,
  deps: SignAndRelayDeps = defaultDeps(),
  agentRow?: SignerWalletRow,
): Promise<OrderOutcome> {
  const walletAddress = deployment.walletAddress;
  if (!walletAddress) throw new ExecutionError("deployment has no wallet address");
  if (!deployment.positionSize || !deployment.entryPx) {
    throw new ExecutionError("no expected position to close");
  }
  const coin = await requireCoin(deployment);
  const agent = agentRow ?? (await requireApprovedAgent(deployment.userId));
  const venue = await loadVenueContext(walletAddress, coin);

  const account = deps.signer.getAccount({ walletId: agent.walletId, address: agent.agentAddress as `0x${string}` });
  const closeLong = deployment.positionSize > 0; // closing a long = sell
  const size = formatSz(Math.abs(deployment.positionSize), venue.szDecimals);
  const px = formatPx(
    venue.markPx * (closeLong ? 1 - BOT_SLIPPAGE_BPS / 10_000 : 1 + BOT_SLIPPAGE_BPS / 10_000),
    venue.szDecimals,
  );
  const cloid = makeCloid(deployment.id, barT, "exit");

  return withUserSigningLock(deployment.userId, async () => {
    // Cancel resting triggers first so the close can't race them.
    const cancels = [deployment.tpOid, deployment.slOid]
      .filter((o): o is string => o !== null)
      .map((o) => ({ a: venue.assetIndex, o: Number(o) }));
    if (cancels.length > 0) {
      // Best-effort: an already-gone trigger must not block the close.
      await signAndRelay(account, { type: "cancel", cancels }, deps).catch(() => {});
    }

    const closeAction = {
      type: "order",
      orders: [
        {
          a: venue.assetIndex,
          b: !closeLong,
          p: px,
          s: size,
          r: true,
          t: { limit: { tif: "Ioc" } },
          c: cloid,
        },
      ],
      grouping: "na",
    };
    const res = await signAndRelay(account, closeAction, deps);
    let outcome = parseOrderResponse(res, cloid);
    outcome = await confirmIfResting(outcome, walletAddress, deps);
    return outcome;
  });
}

async function confirmIfResting(
  outcome: OrderOutcome,
  walletAddress: string,
  deps: SignAndRelayDeps,
): Promise<OrderOutcome> {
  if (outcome.filled || outcome.oid === null) return outcome;
  for (let i = 0; i < CONFIRM_POLLS; i++) {
    await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
    const os = await deps.pollStatus(walletAddress, outcome.oid);
    if (os.status === "order" && os.order.status === "filled") {
      return { ...outcome, filled: true };
    }
    if (os.status === "order" && ["canceled", "rejected", "marginCanceled"].includes(os.order.status)) {
      throw new ExecutionError(`order ${os.order.status}`);
    }
  }
  return outcome;
}

async function requireCoin(deployment: DeploymentRow): Promise<string> {
  const { db } = await import("@/server/db");
  const { assets } = await import("@/server/db/schema");
  const { eq } = await import("drizzle-orm");
  const [asset] = await db.select().from(assets).where(eq(assets.id, deployment.assetId));
  if (!asset?.hyperliquidSymbol) {
    throw new ExecutionError("asset has no Hyperliquid market — cannot trade live");
  }
  return asset.hyperliquidSymbol;
}
