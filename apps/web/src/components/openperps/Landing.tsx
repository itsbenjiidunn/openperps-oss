/// OpenPerps marketing home. Punchy, plain-spoken voice, short declarative
/// lines, no protocol jargon. A visitor should get it in one read: turn any
/// Solana token into a perp market, no permission, trade it in one click.
/// CTAs route into the app (/app) and the launcher (/launch).

import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import logo from "@/assets/openperps-logo.png";
import { useSlot } from "@/hooks/useSlot";
import "./landing.css";

const PROGRAM_ID = "4zZDZaAEWmVdc6phAKCbpe5CgvZJZosLtpiJUEHnxNzy";
const EXPLORER = `https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`;

// Sample markets for the moving ticker (illustrative, devnet).
const TICKER: [string, string, string][] = [
  ["SOL-PERP", "150.00", "live"],
  ["BTC-PERP", "95,000.00", "live"],
  ["ETH-PERP", "3,500.00", "live"],
  ["BONK-PERP", "0.000020", "live"],
  ["JUP-PERP", "0.8000", "live"],
  ["your token?", "list it", "→"],
];

export function Landing() {
  const bars = useMemo(() => Array.from({ length: 24 }, () => 25 + Math.random() * 70), []);
  const graph = useMemo(buildGraph, []);

  return (
    <div className="op-home">
      <div className="bgfx" />
      <div className="grid-lines" />

      {/* nav */}
      <nav>
        <Link to="/" className="brand">
          <img src={logo} alt="OpenPerps" />
          OpenPerps
        </Link>
        <div className="navlinks">
          <a href="#how">How it works</a>
          <a href="#why">Why</a>
          <a href="#stats">Stats</a>
          <Link to="/about">About</Link>
        </div>
        <div className="nav-right">
          <Link to="/launch" className="btn btn-ghost">
            List a market
          </Link>
          <Link to="/app" className="btn btn-teal">
            Open App →
          </Link>
        </div>
      </nav>

      {/* hero */}
      <section className="hero">
        <div>
          <span className="eyebrow">
            <span className="d" />
            LIVE ON DEVNET
          </span>
          <h1 className="hero-h">
            Any Solana token.
            <br />
            A real perp market.
            <br />
            <span className="grad">No permission.</span>
          </h1>
          <p className="hero-sub">
            Turn any token into a market and trade it long or short. Even the ones no exchange will
            list. Nobody approves it. Nobody can shut it down. You keep your own keys.
          </p>
          <p className="hero-earn">One balance. One click. Long or short anything listed.</p>
          <div className="hero-cta">
            <Link to="/app" className="btn btn-teal btn-lg">
              Start trading →
            </Link>
            <Link to="/launch" className="btn btn-vio btn-lg">
              List a market
            </Link>
            <Link to="/faucet" className="btn btn-ghost btn-lg">
              Get test USDC
            </Link>
          </div>
          <div className="hero-stats">
            <div className="s">
              <div className="n teal">20×</div>
              <div className="l">long or short</div>
            </div>
            <div className="s">
              <div className="n">1-click</div>
              <div className="l">no popup per trade</div>
            </div>
            <div className="s">
              <div className="n">0</div>
              <div className="l">admins, ever</div>
            </div>
          </div>
        </div>

        {/* viz */}
        <div className="viz">
          <svg viewBox="0 0 460 460">
            <defs>
              <radialGradient id="ng">
                <stop offset="0%" stopColor="#9fffec" />
                <stop offset="100%" stopColor="#14a98e" />
              </radialGradient>
              <linearGradient id="edge" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="rgba(46,230,194,.6)" />
                <stop offset="100%" stopColor="rgba(125,107,255,.35)" />
              </linearGradient>
            </defs>
            <g stroke="url(#edge)" strokeWidth="1.2" fill="none" opacity=".55">
              {graph.edges.map((e, i) => (
                <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} />
              ))}
            </g>
            <g>
              {graph.nodes.map((n, i) => (
                <circle key={i} className="node" cx={n.x} cy={n.y} r={n.r} fill="url(#ng)">
                  <animate
                    attributeName="opacity"
                    values="0.5;1;0.5"
                    dur={`${2 + Math.random() * 3}s`}
                    repeatCount="indefinite"
                    begin={`${Math.random()}s`}
                  />
                </circle>
              ))}
            </g>
          </svg>
          <div className="pricecard c1">
            <div className="t">SOL-PERP · PRICE</div>
            <div className="p">150.00</div>
            <div className="ch">live</div>
          </div>
          <div className="pricecard c2">
            <div className="t">FUNDING</div>
            <div className="p teal">0.0000%</div>
            <div className="ch">every hour</div>
          </div>
          <div className="pricecard c3">
            <div className="t">LEVERAGE</div>
            <div className="p">20×</div>
            <div className="ch">long or short</div>
          </div>
        </div>
      </section>

      {/* ticker */}
      <div className="ticker">
        <div className="ticker-row">
          {[...TICKER, ...TICKER].map((t, i) => (
            <span key={i}>
              {t[0]} <b>{t[1]}</b> <span className="up">{t[2]}</span>
            </span>
          ))}
        </div>
      </div>

      {/* HOW IT WORKS */}
      <section className="section" id="how">
        <div className="dex-grid">
          <div>
            <div className="sec-label">HOW IT WORKS</div>
            <h2 className="sec-h">
              List a token. <span className="teal">Trade it in one click.</span>
            </h2>
            <p className="sec-lead">
              Pick a token. Set it live. From that second, anyone can go long or short on it.
              There's no approval to wait for, and no admin who can pull the plug or touch your
              funds.
            </p>
            <div className="feat-list">
              <div className="feat">
                <div className="ic">⚡</div>
                <div>
                  <div className="ti">One-click trading</div>
                  <div className="de">
                    Switch it on once. After that, trades fire with no popup.
                  </div>
                </div>
              </div>
              <div className="feat">
                <div className="ic">↗</div>
                <div>
                  <div className="ti">Up to 20× leverage</div>
                  <div className="de">Long or short, all backed by one USDC balance.</div>
                </div>
              </div>
              <div className="feat">
                <div className="ic">◎</div>
                <div>
                  <div className="ti">The long tail, finally tradable</div>
                  <div className="de">Markets for tokens nothing else will list.</div>
                </div>
              </div>
              <div className="feat">
                <div className="ic">✦</div>
                <div>
                  <div className="ti">Nobody can stop you</div>
                  <div className="de">No permission. No admin key. No gatekeepers.</div>
                </div>
              </div>
            </div>
          </div>

          <div className="term">
            <div className="term-bar">
              <span className="tdot" style={{ background: "#ff5d6c" }} />
              <span className="tdot" style={{ background: "#ffb347" }} />
              <span className="tdot" style={{ background: "var(--teal)" }} />
              <span className="mono dim" style={{ marginLeft: 8, fontSize: 12 }}>
                openperps · terminal
              </span>
            </div>
            <div className="term-body">
              <div className="tline">
                <span className="l">Market</span>
                <span>SOL-PERP</span>
              </div>
              <div className="tline">
                <span className="l">Price</span>
                <span className="teal">150.00</span>
              </div>
              <div className="bars">
                {bars.map((h, i) => (
                  <span key={i} style={{ height: `${h}%` }} />
                ))}
              </div>
              <div className="tline">
                <span className="l">Size</span>
                <span className="mono">800.00 USDC</span>
              </div>
              <div className="tline">
                <span className="l">Leverage</span>
                <span className="mono teal">8×</span>
              </div>
              <Link to="/app" className="btn btn-teal term-cta">
                Open Long · SOL-PERP ⚡
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* STATS */}
      <div className="band" id="stats">
        <div className="band-inner">
          <Stat value={20} suffix="×" label="max leverage" />
          <Stat value={0} label="admin keys" />
          <Stat value={100} suffix="%" label="settled on-chain" />
          <SlotStat />
        </div>
      </div>

      {/* WHY */}
      <section className="section" id="why">
        <div className="sec-label">WHY OPENPERPS</div>
        <h2 className="sec-h">Open by default</h2>
        <p className="sec-lead">
          No company runs the order flow. No key can freeze your account. Every market and every
          trade lives on-chain, and anyone can take part.
        </p>
        <div className="cards3">
          <Link to="/launch" className="card">
            <div className="ic">✦</div>
            <h3>List a market</h3>
            <p>
              Pick any token and set it live in a couple of clicks. No new coin to mint, nobody to
              ask for permission.
            </p>
            <div className="arrow">launch one →</div>
          </Link>
          <Link to="/vault" className="card">
            <div className="ic">◍</div>
            <h3>Be the house</h3>
            <p>
              Put USDC into the shared pool that takes the other side of every trade, and earn from
              the flow that runs through it.
            </p>
            <div className="arrow">open the vault →</div>
          </Link>
          <Link to="/app" className="card">
            <div className="ic">⚡</div>
            <h3>Trade in one click</h3>
            <p>Go long or short on any listed market, with leverage, from a single USDC balance.</p>
            <div className="arrow">open the app →</div>
          </Link>
        </div>
      </section>

      {/* CTA */}
      <div className="bigcta">
        <div className="bigcta-inner">
          <h2>
            Any token. Any market.
            <br />
            No permission.
          </h2>
          <p>Live on devnet. Bring a wallet and grab some test USDC.</p>
          <div className="row">
            <Link to="/app" className="btn btn-teal btn-lg">
              Start trading →
            </Link>
            <Link to="/launch" className="btn btn-ghost btn-lg">
              List a market
            </Link>
          </div>
        </div>
      </div>

      {/* FOOTER */}
      <footer>
        <div className="foot">
          <div>
            <div className="brand">
              <img src={logo} alt="OpenPerps" />
              OpenPerps
            </div>
            <p>
              Perpetual futures for any Solana token. No permission, no admin keys. An experimental
              devnet build. Not audited, no real money.
            </p>
          </div>
          <div className="fcol">
            <h4>PRODUCT</h4>
            <Link to="/app">Trade</Link>
            <Link to="/launch">Launch</Link>
            <Link to="/vault">Vault</Link>
            <Link to="/portfolio">Portfolio</Link>
          </div>
          <div className="fcol">
            <h4>LEARN</h4>
            <Link to="/about">How it works</Link>
            <Link to="/faucet">Faucet</Link>
            <a href={EXPLORER} target="_blank" rel="noopener noreferrer">
              View the contract
            </a>
          </div>
          <div className="fcol">
            <h4>START</h4>
            <Link to="/launch">List a market</Link>
            <Link to="/app">Open the app</Link>
            <Link to="/faucet">Get test USDC</Link>
          </div>
        </div>
        <div className="foot-bot">
          <span>© 2026 OpenPerps</span>
          <span className="warn">⚠ Experimental · not audited · devnet only</span>
        </div>
      </footer>
    </div>
  );
}

function Stat({ value, suffix, label }: { value: number; suffix?: string; label: string }) {
  const n = useCountUp(value);
  return (
    <div className="bstat">
      <div className="n">
        {n.toLocaleString()}
        {suffix ?? ""}
      </div>
      <div className="l">{label}</div>
    </div>
  );
}

function SlotStat() {
  const slot = useSlot();
  return (
    <div className="bstat">
      <div className="n">{slot ? slot.toLocaleString() : "—"}</div>
      <div className="l">live devnet block</div>
    </div>
  );
}

/// Count from 0 to `target` once on mount (the stats band is above the fold).
function useCountUp(target: number): number {
  const [val, setVal] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const dur = 1100;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      setVal(Math.floor(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
      else setVal(target);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return val;
}

type Node = { x: number; y: number; r: number };
type Edge = { x1: number; y1: number; x2: number; y2: number };

function buildGraph(): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const N = 10;
  const cx = 230;
  const cy = 230;
  nodes.push({ x: cx, y: cy, r: 11 });
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const rad = 140 + (i % 2 ? 38 : 0);
    nodes.push({ x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad, r: 5 + Math.random() * 3 });
  }
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * Math.PI * 2;
    const rad = 70 + Math.random() * 40;
    nodes.push({ x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad, r: 3 + Math.random() * 2 });
  }
  const edges: Edge[] = [];
  nodes.forEach((n, i) => {
    nodes.forEach((m, j) => {
      if (j > i) {
        const d = Math.hypot(n.x - m.x, n.y - m.y);
        if (d < 150 && Math.random() > 0.45) {
          edges.push({ x1: n.x, y1: n.y, x2: m.x, y2: m.y });
        }
      }
    });
  });
  return { nodes, edges };
}
