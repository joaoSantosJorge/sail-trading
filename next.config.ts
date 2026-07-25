import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    // The wallets section became "Portfolio"; keep old bookmarks working.
    return [{ source: "/wallets", destination: "/portfolio", permanent: true }];
  },
  webpack: (config) => {
    // wagmi's Coinbase connector transitively imports @coinbase/cdp-sdk, whose
    // x402 payment feature references optional @x402/* packages that are not
    // published as resolvable deps. That code path is never exercised here —
    // stub the modules so webpack doesn't fail the build.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@x402/core/client": false,
      "@x402/evm": false,
      "@x402/evm/exact/client": false,
      "@x402/evm/upto/client": false,
      "@x402/svm/exact/client": false,
    };
    return config;
  },
};

export default nextConfig;
