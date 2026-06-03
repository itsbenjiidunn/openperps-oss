/// Live spot price lookup so the launcher doesn't make you type a price for
/// assets that already have one. Pyth Hermes (REST, public, CORS-ok) for
/// assets with a feed id; Jupiter price API by mint as a fallback. Returns
/// null when neither resolves (e.g. a devnet-only custom mint) so the caller
/// falls back to a manual / preset price.

import type { AssetPreset } from "./assets";
import { geckoProxy } from "./indexer";

const HERMES = "https://hermes.pyth.network/v2/updates/price/latest";
const JUP = "https://api.jup.ag/price/v2";

/// Fetch a Pyth price (USD) for a feed id like "0xef0d…". Null on failure.
export async function fetchPythPrice(feedId: string): Promise<number | null> {
  try {
    const id = feedId.startsWith("0x") ? feedId.slice(2) : feedId;
    const res = await fetch(`${HERMES}?ids[]=${id}`);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      parsed?: { price?: { price?: string; expo?: number } }[];
    };
    const p = json.parsed?.[0]?.price;
    if (!p || p.price === undefined || p.expo === undefined) return null;
    const v = Number(p.price) * 10 ** p.expo;
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/// Fetch a Jupiter price (USD) for an SPL mint. Null on failure / unknown
/// (devnet-only mints won't be priced).
export async function fetchJupPrice(mint: string): Promise<number | null> {
  try {
    const res = await fetch(`${JUP}?ids=${mint}`);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: Record<string, { price?: string | number }>;
    };
    const raw = json.data?.[mint]?.price;
    const v = typeof raw === "string" ? Number(raw) : raw;
    return v !== undefined && Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/// GeckoTerminal USD price for a mint, covers pump / long-tail SPL tokens that
/// Jupiter's price API doesn't list. Null on failure.
export async function fetchGeckoPrice(mint: string): Promise<number | null> {
  try {
    const res = await fetch(geckoProxy(`simple/networks/solana/token_price/${mint}`));
    if (!res.ok) return null;
    const j = (await res.json()) as {
      data?: { attributes?: { token_prices?: Record<string, string> } };
    };
    const prices = j.data?.attributes?.token_prices ?? {};
    const raw = prices[mint] ?? Object.values(prices)[0];
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/// DexScreener USD price for a mint, the most reliable source for brand-new
/// pump.fun / long-tail SPL that Jupiter and GeckoTerminal haven't indexed yet.
/// CORS-open, so the browser can call it directly. Null on failure.
export async function fetchDexPrice(mint: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!res.ok) return null;
    const j = (await res.json()) as { pairs?: { priceUsd?: string }[] };
    // Most-liquid pair first; take the first parseable price.
    for (const p of j.pairs ?? []) {
      const v = Number(p.priceUsd);
      if (Number.isFinite(v) && v > 0) return v;
    }
    return null;
  } catch {
    return null;
  }
}

export type PriceResult = { price: number; source: "pyth" | "jupiter" } | null;

/// Best-effort live price for a chosen asset: Pyth feed first, then by mint
/// (GeckoTerminal, then Jupiter) so pump / long-tail SPL still resolve a price.
export async function fetchAssetPrice(args: {
  pythFeedId?: string;
  baseMint?: string;
}): Promise<PriceResult> {
  if (args.pythFeedId) {
    const p = await fetchPythPrice(args.pythFeedId);
    if (p !== null) return { price: p, source: "pyth" };
  }
  if (args.baseMint) {
    const p =
      (await fetchDexPrice(args.baseMint)) ??
      (await fetchGeckoPrice(args.baseMint)) ??
      (await fetchJupPrice(args.baseMint));
    if (p !== null) return { price: p, source: "jupiter" };
  }
  return null;
}

export type TokenMeta = { symbol: string; name: string; decimals?: number } | null;

/// Resolve a mint's ticker / name from Jupiter's token registry so pasting a
/// contract address auto-fills the market name. Null for unknown mints
/// (devnet-only tokens Jupiter has never indexed) → caller keeps manual entry.
export async function fetchTokenMeta(mint: string): Promise<TokenMeta> {
  try {
    const res = await fetch(`https://tokens.jup.ag/token/${mint}`);
    if (res.ok) {
      const j = (await res.json()) as {
        symbol?: string;
        name?: string;
        decimals?: number;
      } | null;
      if (j?.symbol) return { symbol: j.symbol, name: j.name ?? j.symbol, decimals: j.decimals };
    }
  } catch {
    /* try gecko */
  }
  // GeckoTerminal covers pump / long-tail SPL not in Jupiter's token list.
  try {
    const res = await fetch(geckoProxy(`networks/solana/tokens/${mint}`));
    if (res.ok) {
      const j = (await res.json()) as {
        data?: { attributes?: { symbol?: string; name?: string; decimals?: number } };
      };
      const a = j.data?.attributes;
      if (a?.symbol) return { symbol: a.symbol, name: a.name ?? a.symbol, decimals: a.decimals };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export type TokenInfo = {
  symbol?: string;
  name?: string;
  price?: number;
  priceSource?: "jupiter";
};

/// One-shot lookup for a pasted mint: ticker + name + live price. Both halves
/// are best-effort and independent, so a token can resolve a price without a
/// registry entry, or vice versa.
export async function fetchTokenInfo(mint: string): Promise<TokenInfo> {
  const [meta, dex] = await Promise.all([fetchTokenMeta(mint), fetchDexPrice(mint)]);
  // DexScreener first (covers fresh pump tokens), then GeckoTerminal, then
  // Jupiter. A reliable seed price here is critical: a wrong seed (e.g. the old
  // $1 default) makes the keeper crater the mark toward the real price after
  // launch, liquidating anyone who traded at the seed.
  const price = dex ?? (await fetchGeckoPrice(mint)) ?? (await fetchJupPrice(mint));
  return {
    symbol: meta?.symbol,
    name: meta?.name,
    price: price ?? undefined,
    priceSource: price !== null ? "jupiter" : undefined,
  };
}

/// Convenience for a preset.
export function priceArgsForPreset(p: AssetPreset): {
  pythFeedId?: string;
  baseMint?: string;
} {
  return { pythFeedId: p.pythFeedId, baseMint: p.baseMint };
}
