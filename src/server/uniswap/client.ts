import { env } from "../env";
import { TokenBucket } from "../market/rateLimiter";

/**
 * Uniswap Trading API client (quote → check_approval → swap-calldata; the
 * user signs everything in their own wallet). Default key rate limit is
 * 3 req/s — the bucket stays under it.
 */

const BASE = "https://trade-api.gateway.uniswap.org/v1";

const bucket = new TokenBucket(2, 2);

// Native ETH sentinel used by the trading API.
export const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";

export class UniswapError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export function uniswapConfigured(): boolean {
  return Boolean(env.UNISWAP_API_KEY);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  if (!env.UNISWAP_API_KEY) {
    throw new UniswapError("UNISWAP_API_KEY is not set — add it to .env.local");
  }
  await bucket.take();
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": env.UNISWAP_API_KEY },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new UniswapError(`Uniswap ${path} ${res.status}: ${text.slice(0, 400)}`, res.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UniswapError(`Uniswap ${path}: invalid JSON response`);
  }
}

export type QuoteRequest = {
  chainId: number;
  swapper: string;
  tokenIn: string; // address or NATIVE_TOKEN
  tokenOut: string;
  amountIn: string; // raw units (wei-style integer string)
  slippageBps: number;
};

// The API's response shapes are passed through mostly opaquely (stored on the
// execution row and echoed back to /swap); we pick out the fields we validate.
export type QuoteResponse = {
  quote: Record<string, unknown> & {
    output?: { amount?: string };
    priceImpact?: number;
  };
  permitData?: Record<string, unknown> | null;
  routing?: string;
};

export async function fetchQuote(req: QuoteRequest): Promise<QuoteResponse> {
  return post<QuoteResponse>("/quote", {
    type: "EXACT_INPUT",
    tokenInChainId: req.chainId,
    tokenOutChainId: req.chainId,
    swapper: req.swapper,
    tokenIn: req.tokenIn,
    tokenOut: req.tokenOut,
    amount: req.amountIn,
    slippageTolerance: req.slippageBps / 100, // percent
    urgency: "normal",
  });
}

export type ApprovalResponse = {
  approval?: { to?: string; data?: string; value?: string; chainId?: number } | null;
  cancel?: unknown;
};

export async function checkApproval(req: {
  chainId: number;
  walletAddress: string;
  token: string;
  amount: string;
}): Promise<ApprovalResponse> {
  return post<ApprovalResponse>("/check_approval", {
    chainId: req.chainId,
    walletAddress: req.walletAddress,
    token: req.token,
    amount: req.amount,
  });
}

export type SwapResponse = {
  swap?: { to?: string; data?: string; value?: string; chainId?: number; from?: string };
};

export async function buildSwap(req: {
  quote: Record<string, unknown>;
  permitData?: Record<string, unknown> | null;
  signature?: string;
}): Promise<SwapResponse> {
  return post<SwapResponse>("/swap", {
    quote: req.quote,
    ...(req.permitData ? { permitData: req.permitData } : {}),
    ...(req.signature ? { signature: req.signature } : {}),
  });
}
