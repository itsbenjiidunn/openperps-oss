import { createFileRoute, Link } from "@tanstack/react-router";
import logo from "@/assets/openperps-logo.png";
import { Coins, Layers, Rocket, ArrowRight, ShieldCheck, Activity, Zap } from "lucide-react";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "OpenPerps — Permissionless perpetuals on Solana" },
      { name: "description", content: "Slab-free. Zero-copy. Quote-margined. Built on Percolator v16." },
      { property: "og:title", content: "OpenPerps — Permissionless perpetuals on Solana" },
      { property: "og:description", content: "Slab-free. Zero-copy. Quote-margined. Built on Percolator v16." },
    ],
  }),
  component: About,
});

function About() {
  return (
    <div className="hero-bg">
      <section className="px-4 pt-16 pb-20 max-w-6xl mx-auto">
        <div className="flex flex-col items-center text-center">
          <img src={logo} alt="OpenPerps" className="h-32 w-32 drop-shadow-[0_0_40px_oklch(0.86_0.16_188_/_0.6)]" />
          <h1 className="font-display text-6xl md:text-7xl font-bold tracking-tight mt-6">
            Open<span className="text-neon">Perps</span>
          </h1>
          <p className="mt-4 text-lg md:text-xl text-foreground/85">Permissionless perpetuals on Solana</p>
          <p className="mt-3 text-sm md:text-base text-muted-foreground font-mono">
            Slab-free · Zero-copy · Quote-margined · Built on Percolator v16
          </p>

          <div className="mt-8 flex gap-3">
            <Link to="/app" className="btn-primary rounded-md px-5 py-2.5 text-sm font-semibold flex items-center gap-2">
              Open terminal <ArrowRight className="h-4 w-4" />
            </Link>
            <Link to="/launch" className="btn-ghost-border rounded-md px-5 py-2.5 text-sm font-medium">
              Launch a market
            </Link>
          </div>
        </div>

        <div className="mt-20 grid md:grid-cols-3 gap-4">
          <ProofCard
            icon={<Coins className="h-5 w-5 text-neon" />}
            title="SPL custody"
            desc="Native SPL token vaults secure user collateral. PDA-owned, programmatically constrained, auditable on-chain."
            stat="USDC quote-margin"
          />
          <ProofCard
            icon={<Layers className="h-5 w-5 text-electric" />}
            title="Cross-margin portfolios"
            desc="Zero-copy account model unifies risk across all open perp positions. Single solvency check per turn."
            stat="One account · N markets"
          />
          <ProofCard
            icon={<Rocket className="h-5 w-5 text-violet" />}
            title="Permissionless markets"
            desc="Any SPL token with a Pyth or Switchboard feed becomes tradable. Activate without governance approval."
            stat="Deploy in minutes"
          />
        </div>

        <div className="mt-16 grid md:grid-cols-3 gap-4">
          <Pill icon={<ShieldCheck className="h-4 w-4" />} label="Insurance-backed solvency" />
          <Pill icon={<Activity className="h-4 w-4" />} label="Oracle + funding accrual via crank" />
          <Pill icon={<Zap className="h-4 w-4" />} label="Permissionless liquidation bounty" />
        </div>

        <div className="mt-16 panel p-6 max-w-3xl mx-auto">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Architecture</div>
          <pre className="mt-2 text-[11px] md:text-xs font-mono leading-relaxed overflow-x-auto text-foreground/85">
{`registry            → market_state(*)
market_state        → vault(USDC) · oracle · funding · positions[]
account_state       → portfolio cross-margin, zero-copy
crank               → fund accrual · liquidation · solvency
insurance_vault     → backs shortfall before LP socialization`}
          </pre>
        </div>
      </section>
    </div>
  );
}

function ProofCard({ icon, title, desc, stat }: { icon: React.ReactNode; title: string; desc: string; stat: string }) {
  return (
    <div className="panel p-5 hover:glow-border transition-shadow">
      <div className="flex items-center gap-2">{icon}<h3 className="font-display text-base font-semibold">{title}</h3></div>
      <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{desc}</p>
      <div className="mt-4 font-mono text-[11px] text-neon">{stat}</div>
    </div>
  );
}

function Pill({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="panel-flat px-4 py-3 flex items-center gap-2.5 text-xs text-muted-foreground">
      <span className="text-neon">{icon}</span>{label}
    </div>
  );
}
