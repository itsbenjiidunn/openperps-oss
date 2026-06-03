import { Link, useRouterState } from "@tanstack/react-router";
import { LineChart, Rocket, Wallet, Vault, Sparkles, Droplets } from "lucide-react";
import logo from "@/assets/openperps-logo.png";
import { useSlot } from "@/hooks/useSlot";
import { WalletButton } from "./WalletButton";

const nav = [
  { to: "/app", label: "Terminal", icon: LineChart },
  { to: "/faucet", label: "Faucet", icon: Droplets },
  { to: "/launch", label: "Launch", icon: Rocket },
  { to: "/portfolio", label: "Portfolio", icon: Wallet },
  { to: "/vault", label: "Vault", icon: Vault },
  { to: "/about", label: "About", icon: Sparkles },
] as const;

export function Header() {
  const slot = useSlot();
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/70 backdrop-blur-xl">
      <div className="flex h-14 items-center gap-4 px-4">
        <Link to="/" className="flex items-center gap-2.5 group">
          <img
            src={logo}
            alt="OpenPerps"
            className="h-8 w-8 drop-shadow-[0_0_10px_oklch(0.86_0.16_188_/_0.6)]"
          />
          <span className="font-display text-[17px] font-semibold tracking-tight">
            Open<span className="text-neon">Perps</span>
          </span>
        </Link>

        <nav className="ml-4 hidden md:flex items-center gap-1">
          {nav.slice(0, 5).map((n) => (
            <NavLink key={n.to} to={n.to} label={n.label} />
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <div className="hidden lg:flex items-center gap-2 px-2.5 py-1.5 rounded-md panel-flat text-xs font-mono">
            <span
              className={`h-1.5 w-1.5 rounded-full ${slot ? "bg-success pulse-dot" : "bg-muted-foreground"}`}
            />
            <span className="text-muted-foreground">devnet</span>
            <span className="text-foreground/70">·</span>
            <span className="text-muted-foreground">slot</span>
            <span className="text-foreground">{slot ? slot.toLocaleString() : "-"}</span>
          </div>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}

function NavLink({ to, label }: { to: string; label: string }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const active = to === "/" ? path === "/" : path.startsWith(to);
  return (
    <Link
      to={to}
      className={[
        "px-3 py-1.5 rounded-md text-sm transition-colors relative",
        active
          ? "text-neon bg-[oklch(0.86_0.16_188_/_0.08)]"
          : "text-muted-foreground hover:text-foreground",
      ].join(" ")}
    >
      {label}
      {active && (
        <span className="absolute inset-x-3 -bottom-px h-px bg-neon shadow-[0_0_8px_var(--neon)]" />
      )}
    </Link>
  );
}

export function MobileNav() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t border-border bg-background/90 backdrop-blur-xl">
      <ul className="grid grid-cols-5">
        {nav.slice(0, 5).map((n) => {
          const Icon = n.icon;
          const active = path.startsWith(n.to);
          return (
            <li key={n.to}>
              <Link
                to={n.to}
                className={`flex flex-col items-center gap-1 py-2.5 text-[10px] ${active ? "text-neon" : "text-muted-foreground"}`}
              >
                <Icon className="h-[18px] w-[18px]" />
                {n.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
