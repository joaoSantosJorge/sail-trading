import { getPortfolio } from "../alchemy";
import { syncTransfers } from "../transferCache";
import type { ChainAdapter } from "./types";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** EVM ecosystem via Alchemy: balances (Portfolio API) + transfer history
 * (getAssetTransfers) across eth/base/arb/op/polygon mainnets. */
export const evmAdapter: ChainAdapter = {
  kind: "evm",
  validateAddress: (address) => ADDRESS_RE.test(address),
  getBalances: getPortfolio,
  syncTransfers: (db, args) => syncTransfers(db, args),
};
