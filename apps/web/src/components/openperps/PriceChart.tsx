import { useMemo } from "react";

type Props = {
  className?: string;
  color?: string;
  volume?: boolean;
  seed?: number;
};

// Deterministic mock price chart (SVG)
export function PriceChart({ className, color = "var(--neon)", volume = true, seed = 1 }: Props) {
  const { path, area, vols, lastY, min, max } = useMemo(() => {
    const N = 96;
    let v = 50 + seed * 7;
    const points: number[] = [];
    for (let i = 0; i < N; i++) {
      v +=
        (Math.sin(i * 0.35 + seed) + Math.cos(i * 0.11 + seed * 2)) * 1.6 +
        Math.sin(i * 1.9 + seed) * 0.6;
      points.push(v);
    }
    const min = Math.min(...points),
      max = Math.max(...points);
    const W = 1000,
      H = 320;
    const x = (i: number) => (i / (N - 1)) * W;
    const y = (p: number) => H - ((p - min) / (max - min || 1)) * (H - 20) - 10;
    const path = points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(2)} ${y(p).toFixed(2)}`)
      .join(" ");
    const area = path + ` L ${W} ${H} L 0 ${H} Z`;
    const vols = points.map((_, i) => 8 + ((Math.sin(i * 0.7 + seed) + 1) / 2) * 42);
    return { path, area, vols, lastY: y(points[N - 1]), min, max };
  }, [seed]);

  return (
    <div className={`relative w-full ${className ?? ""}`}>
      <div className="absolute inset-0 grid-bg opacity-40 rounded-md" />
      <svg viewBox="0 0 1000 380" className="relative w-full h-full">
        <defs>
          <linearGradient id={`area-${seed}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
          <filter id={`glow-${seed}`}>
            <feGaussianBlur stdDeviation="2.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {volume && (
          <g opacity="0.7">
            {vols.map((h, i) => (
              <rect
                key={i}
                x={(i / vols.length) * 1000}
                y={380 - h}
                width={1000 / vols.length - 2}
                height={h}
                fill="var(--violet)"
                opacity="0.35"
              />
            ))}
          </g>
        )}

        <path d={area} fill={`url(#area-${seed})`} />
        <path d={path} fill="none" stroke={color} strokeWidth="1.8" filter={`url(#glow-${seed})`} />
        <line
          x1="0"
          x2="1000"
          y1={lastY}
          y2={lastY}
          stroke={color}
          strokeDasharray="3 4"
          strokeWidth="0.8"
          opacity="0.5"
        />
        <circle cx="1000" cy={lastY} r="4" fill={color} />
      </svg>
      <div className="absolute top-2 right-3 font-mono text-[10px] text-muted-foreground">
        H {max.toFixed(2)} · L {min.toFixed(2)}
      </div>
    </div>
  );
}
