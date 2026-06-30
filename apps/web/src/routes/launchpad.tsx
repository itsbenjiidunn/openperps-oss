import { createFileRoute } from "@tanstack/react-router";
import { Rocket } from "lucide-react";

import { LaunchpadPanel } from "@/components/openperps/LaunchpadPanel";

export const Route = createFileRoute("/launchpad")({
  head: () => ({
    meta: [
      { title: "Launchpad: OpenPerps" },
      {
        name: "description",
        content:
          "Mint a token and stand up a coin-margin perp on it in one flow. The creator allocation seeds the perp House (productive, not locked) instead of being locked, optionally behind a rug-proof timelock.",
      },
    ],
  }),
  component: Launchpad,
});

function Launchpad() {
  return (
    <div className="px-4 py-6 max-w-3xl mx-auto">
      <header className="mb-6 flex items-start gap-4">
        <div className="p-2.5 rounded-md panel-flat glow-border">
          <Rocket className="h-5 w-5 text-neon" />
        </div>
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">OPP Launchpad</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Launch a brand-new token <span className="text-foreground">with a perp on it</span> in
            one flow. Instead of locking your allocation, it seeds the market's House as productive
            liquidity that earns the House edge. The market is coin-margin (the token is the
            collateral), auto-capped to <span className="text-foreground">5x</span>, with an optional
            rug-proof timelock on the seed. To list a perp for an{" "}
            <span className="text-foreground">existing</span> asset instead, use Launch.
          </p>
        </div>
      </header>

      <LaunchpadPanel />
    </div>
  );
}
