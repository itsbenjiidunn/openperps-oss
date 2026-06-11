/// Break-even report for the House / HLP. Runs the canonical memecoin scenarios
/// and prints the P&L decomposition, then the fee-to-House counterfactual.
///
///   npm run report -w @openperps/sim
///
/// Read the conclusion at the bottom, not just the numbers.

import { simulate, SLOTS_PER_DAY, type MarketParams, type SimResult } from "../src/economics.ts";
import { balancedChurn, sustainedPumpHold, fastPumpExit } from "../src/scenarios.ts";

// A representative custom (memecoin) market: a $1 token, $1M House seed, a 100k-base
// House cap (so at $1 the House risks up to ~$100k net exposure), 10 bps fee floor.
const market: MarketParams = {
  houseCapBase: 100_000,
  feeBps: 10,
  houseCapital: 1_000_000,
};

const usd = (n: number) =>
  (n < 0 ? "-$" : "$") +
  Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const pct = (n: number) => (n * 100).toFixed(2) + "%";

function row(name: string, r: SimResult): void {
  console.log(
    [
      name.padEnd(26),
      ("inv " + usd(r.inventoryPnl)).padEnd(16),
      ("fund " + usd(r.fundingIncome)).padEnd(14),
      ("fee -" + usd(r.feesPaid)).padEnd(13),
      ("equity " + usd(r.finalEquity)).padEnd(20),
      ("ret " + pct(r.returnOnSeed)).padEnd(16),
      r.brokeSeed ? "SEED BLOWN" : "",
    ].join(" "),
  );
}

console.log(
  `House sim -- seed ${usd(market.houseCapital)}, cap ${market.houseCapBase.toLocaleString()} base, ` +
    `fee floor ${market.feeBps} bps. (${Math.round(SLOTS_PER_DAY).toLocaleString()} slots/day)\n`,
);
console.log("=== current engine (House pays the fee, earns only skew funding) ===");

const scenarios: Array<[string, ReturnType<typeof balancedChurn>]> = [
  ["balanced churn (flat)", balancedChurn({ price: 1, perStepFlow: 2_000, steps: 400, dtSlots: 100 })],
  ["sustained 3x pump (hold)", sustainedPumpHold({ p0: 1, pEnd: 3, size: 1_000_000, steps: 200 })],
  ["fast 2x pump + exit", fastPumpExit({ p0: 1, pEnd: 2, size: 100_000, rampSteps: 10, dtSlots: 5 })],
];
for (const [name, path] of scenarios) row(name, simulate(market, path));

console.log("\n=== counterfactual: House EARNS a 30 bps maker fee (not in the engine) ===");
const withMaker: MarketParams = { ...market, feeToHouseBps: 30 };
for (const [name, path] of scenarios) row(name, simulate(withMaker, path));

console.log(`
--- conclusion -------------------------------------------------------------
Skew funding is capped at ~0.2%/day at full imbalance, which is negligible next
to a memecoin's moves, and the trading fee is PAID by the House (it routes to
insurance), not earned. So under the current engine the House is NOT a yield
role on one-sided memecoin flow: it is a bounded-loss backstop. The House cap is
load-bearing -- it caps the inventory loss -- but balanced churn still bleeds the
fee, and a fast pump-and-exit realizes a real (bounded) loss.

The counterfactual shows the lever: routing a maker fee TO the House (a real
spread for taking the unpopular side) is what turns volume into LP yield. That is
an engine/wrapper change, not a parameter tweak. Until then, set the House cap to
a loss you can fund, treat the House as a customer-acquisition cost, and monetize
at the App/integrator layer, not at the LP.
----------------------------------------------------------------------------`);
