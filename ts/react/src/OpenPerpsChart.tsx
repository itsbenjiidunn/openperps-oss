/// A chart shell. OpenPerps does not provide market data in v1: the host passes
/// candles (from their own source) and this renders a simple close-price line.
/// Bring a full charting library for richer rendering; this is the zero-
/// dependency default.

import { type ReactElement } from "react";
import type { OpenPerpsMarketConfig } from "@openperps/sdk";

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type OpenPerpsChartProps = {
  market: OpenPerpsMarketConfig;
  candles: Candle[];
  width?: number;
  height?: number;
  className?: string;
};

export function OpenPerpsChart({
  candles,
  width = 320,
  height = 120,
  className,
}: OpenPerpsChartProps): ReactElement {
  const closes = candles.map((c) => c.close);

  let path = "";
  if (closes.length >= 2) {
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const span = max - min || 1;
    const stepX = width / (closes.length - 1);
    path = closes
      .map((v, i) => {
        const x = i * stepX;
        const y = height - ((v - min) / span) * height;
        return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  }

  return (
    <svg
      className={className ?? "openperps-chart"}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="price chart"
    >
      {path ? (
        <path d={path} fill="none" stroke="currentColor" strokeWidth={2} />
      ) : null}
    </svg>
  );
}
