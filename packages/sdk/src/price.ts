import type { OpenPerpsMarketConfig } from "./config.ts";

/// A price reading for a market. `price` is an integer in the market's
/// `priceDecimals` scale; the source string and timestamp let consumers reason
/// about freshness and provenance.
export type OpenPerpsPrice = {
  price: bigint;
  confidence?: bigint;
  slot?: number;
  source: string;
  timestampMs: number;
};

/// The interface an integrator implements to feed prices to the keeper. v1 does
/// not ship a built-in data provider: bring Birdeye, Pyth, a pool read, Geyser,
/// or your own oracle.
export type PriceProvider = {
  getPrice(market: OpenPerpsMarketConfig): Promise<OpenPerpsPrice>;
};

/// A fixed-price provider for tests and demos.
export function createStaticPriceProvider(price: bigint, source = "static"): PriceProvider {
  return {
    async getPrice() {
      return {
        price,
        source,
        timestampMs: Date.now(),
      };
    },
  };
}

/// Minimal structural shape of `fetch`, so the live provider runs in the browser
/// or Node on the global `fetch`, and tests (or a custom HTTP agent / proxy) can
/// inject their own. The global `fetch` satisfies it directly.
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/// Off-chain USD price sources the live provider knows how to read. Both are
/// CORS-open and free, so they work unproxied from a browser or a keeper:
///   - `dexscreener`: the deepest Solana pair's `priceUsd` (covers any token with
///     a pool, including pump.fun / long-tail SPL).
///   - `jupiter`: the Jupiter price API (good coverage for routed tokens).
export type LivePriceSourceId = "dexscreener" | "jupiter";

export type LivePriceProviderOptions = {
  /// Source order to try; the first that returns a valid price wins. Default
  /// `["dexscreener", "jupiter"]`.
  sources?: LivePriceSourceId[];
  /// Injected `fetch`. Defaults to the global `fetch`; throws on construction if
  /// neither is available.
  fetchImpl?: FetchLike;
  /// Per-request timeout in ms (each source call). Default 6000.
  timeoutMs?: number;
  /// When all sources fail, return the last good reading for that market (with
  /// its original, now-stale `timestampMs`, and `source` tagged `:last-known`)
  /// instead of throwing. Lets a relayer hold the last price rather than letting
  /// the on-chain oracle fall to zero. Default true.
  holdLastKnown?: boolean;
  /// Reject a source value above this many USD per token as garbage. Default 1e9.
  maxPriceUsd?: number;
};

/// A live `PriceProvider` for ANY Solana token: it reads the token's USD price
/// off DexScreener then Jupiter, scales it into the market's integer
/// `priceDecimals`, and (by default) holds the last good reading when both
/// sources are momentarily down. This is the reusable price feed for relayer /
/// keeper markets that have no Pyth feed (custom SPL, memecoins); majors should
/// price off `CrankPyth` / a Pyth provider instead.
///
/// The provider keeps per-market last-known state, so reuse one instance across
/// crank cycles. It performs no on-chain reads; it maps `market.baseMint` to a
/// USD price and `market.priceDecimals` to the engine mark scale.
export function createLivePriceProvider(
  opts: LivePriceProviderOptions = {},
): PriceProvider & { lastKnown(marketId: string): OpenPerpsPrice | undefined } {
  const sources = opts.sources ?? ["dexscreener", "jupiter"];
  const timeoutMs = opts.timeoutMs ?? 6_000;
  const holdLastKnown = opts.holdLastKnown ?? true;
  const maxPriceUsd = opts.maxPriceUsd ?? 1e9;
  const maybeFetch =
    opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!maybeFetch) {
    throw new Error(
      "createLivePriceProvider: no fetch available; pass options.fetchImpl",
    );
  }
  const fetchImpl: FetchLike = maybeFetch;

  const lastKnown = new Map<string, OpenPerpsPrice>();

  async function readUsd(source: LivePriceSourceId, mint: string): Promise<number | null> {
    const json =
      source === "dexscreener"
        ? await fetchJson(fetchImpl, `https://api.dexscreener.com/latest/dex/tokens/${mint}`, timeoutMs)
        : await fetchJson(fetchImpl, `https://api.jup.ag/price/v2?ids=${mint}`, timeoutMs);
    if (json === null) return null;
    const usd = source === "dexscreener" ? parseDexScreener(json) : parseJupiter(json, mint);
    if (usd === null || !Number.isFinite(usd) || usd <= 0 || usd > maxPriceUsd) return null;
    return usd;
  }

  return {
    lastKnown(marketId: string) {
      return lastKnown.get(marketId);
    },
    async getPrice(market: OpenPerpsMarketConfig): Promise<OpenPerpsPrice> {
      for (const source of sources) {
        let usd: number | null = null;
        try {
          usd = await readUsd(source, market.baseMint);
        } catch {
          usd = null;
        }
        if (usd === null) continue;
        const price = usdToPriceInt(usd, market.priceDecimals);
        if (price <= 0n) continue;
        const reading: OpenPerpsPrice = { price, source, timestampMs: Date.now() };
        lastKnown.set(market.id, reading);
        return reading;
      }
      const prev = lastKnown.get(market.id);
      if (holdLastKnown && prev) {
        // Keep the original (stale) timestamp so a freshness gate sees it as old.
        return { ...prev, source: `${prev.source}:last-known` };
      }
      throw new Error(
        `no live price for ${market.symbol} (${market.baseMint}) from [${sources.join(", ")}]`,
      );
    },
  };
}

/// Scale a USD price (float) into the market's integer `priceDecimals` scale,
/// rounded to the nearest unit. Returns 0n for a non-positive or non-finite
/// input. Shifts the decimal point with string ops rather than multiplying a
/// float by a large power of ten, so it does not drop low-order digits for a
/// tiny memecoin price.
export function usdToPriceInt(priceUsd: number, priceDecimals: number): bigint {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return 0n;
  if (!Number.isInteger(priceDecimals) || priceDecimals < 0 || priceDecimals > 18) {
    throw new Error(`usdToPriceInt: invalid priceDecimals ${priceDecimals}`);
  }
  // toFixed rounds to exactly `priceDecimals` fractional digits; concatenating
  // the integer and fractional parts then yields the scaled integer.
  const fixed = priceUsd.toFixed(priceDecimals);
  const [intPart, fracPart = ""] = fixed.split(".");
  const digits = (intPart + fracPart).replace(/^0+(?=\d)/, "");
  return BigInt(digits === "" ? "0" : digits);
}

async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/// Deepest Solana pair's `priceUsd` from a DexScreener `/tokens/{mint}` response.
function parseDexScreener(json: unknown): number | null {
  const pairs = (json as { pairs?: unknown }).pairs;
  if (!Array.isArray(pairs)) return null;
  let best: { liq: number; price: number } | null = null;
  for (const raw of pairs) {
    const p = raw as {
      chainId?: string;
      priceUsd?: string;
      liquidity?: { usd?: number };
    };
    if (p.chainId !== "solana") continue;
    const price = Number(p.priceUsd);
    if (!Number.isFinite(price) || price <= 0) continue;
    const liq = Number(p.liquidity?.usd) || 0;
    if (!best || liq > best.liq) best = { liq, price };
  }
  return best?.price ?? null;
}

/// `data[mint].price` from a Jupiter price-v2 response.
function parseJupiter(json: unknown, mint: string): number | null {
  const data = (json as { data?: Record<string, { price?: string | number } | undefined> }).data;
  const raw = data?.[mint]?.price;
  const price = typeof raw === "string" ? Number(raw) : raw;
  return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
}
