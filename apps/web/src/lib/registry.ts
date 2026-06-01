/// localStorage-backed registry of markets the user has launched (or
/// imported by pubkey). This is a stop-gap until an indexer / on-chain
/// registry account exists.

const KEY = "openperps:markets";

export type RegistryEntry = {
  pubkey: string;
  symbol: string;
  base: string;
  quoteMint: string;
  vault: string;
  assetSlotCapacity: number;
  /// Asset slot index of this pair within the shared market group.
  assetIndex: number;
  /// SPL mint of the underlying asset, if it is tokenized on Solana.
  /// Undefined for synthetics (BTC, ETH) traded off a price feed alone.
  baseMint?: string;
  /// "dex" → priced from a DEX pool's on-chain EWMA; "pyth" → a
  /// Pyth feed bound (CPI pending); "manual" → authority-set price.
  oracleKind?: "pyth" | "manual" | "dex";
  /// Pyth price-feed id (hex) when oracleKind === "pyth".
  oracleFeedId?: string;
  /// DEX pool account address when oracleKind === "dex".
  oraclePool?: string;
  /// Max leverage from the chosen risk tier — display metadata for now.
  maxLeverage?: number;
  /// Taker fee in bps set at launch; drives the default PlaceOrder fee.
  feeBps?: number;
  /// Seed/oracle price in USD set at launch (ActivateMarket). Used to
  /// prefill the order panel and show a mark until the Pyth CPI lands.
  seedPriceUsd?: number;
  /// Custom SPL markets are their OWN isolated group (separate market account
  /// + vault + House seeded by the creator), so trades/positions on them never
  /// touch the shared majors pool. `house`/`houseBump` are that group's House
  /// portfolio PDA; `ownGroup` flags it as a standalone group (vs a slot in the
  /// shared group). Majors/shared markets leave these unset.
  house?: string;
  houseBump?: number;
  ownGroup?: boolean;
  /// mUSDC the creator seeded into the group's House (LP + insurance), human.
  seedLp?: number;
  /// Wall-clock ms when the user added it; just for sorting.
  addedAt: number;
};

function readRaw(): RegistryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as RegistryEntry[];
  } catch {
    return [];
  }
}

function writeRaw(entries: RegistryEntry[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(entries));
}

export function listMarkets(): RegistryEntry[] {
  return readRaw().sort((a, b) => b.addedAt - a.addedAt);
}

export function addMarket(entry: Omit<RegistryEntry, "addedAt">): void {
  const existing = readRaw();
  const without = existing.filter((m) => m.pubkey !== entry.pubkey);
  without.push({ ...entry, addedAt: Date.now() });
  writeRaw(without);
}

export function removeMarket(pubkey: string): void {
  writeRaw(readRaw().filter((m) => m.pubkey !== pubkey));
}

export function clearRegistry(): void {
  writeRaw([]);
}
