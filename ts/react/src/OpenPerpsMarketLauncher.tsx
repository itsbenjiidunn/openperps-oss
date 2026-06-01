/// Show the ordered creation plan for a custom market and a launch button. The
/// plan comes from the SDK's pure `planMarketCreation`; wiring the actual
/// transactions is left to the host via `onLaunch`.

import { type ReactElement } from "react";
import {
  planMarketCreation,
  type OpenPerpsMarketCreationIntent,
} from "@openperps/sdk";

export type OpenPerpsMarketLauncherProps = {
  intent: OpenPerpsMarketCreationIntent;
  includeMockPool?: boolean;
  onLaunch?: (intent: OpenPerpsMarketCreationIntent) => void;
  className?: string;
};

export function OpenPerpsMarketLauncher({
  intent,
  includeMockPool,
  onLaunch,
  className,
}: OpenPerpsMarketLauncherProps): ReactElement {
  const plan = planMarketCreation(intent, {
    includeMockPool: includeMockPool ?? false,
  });

  return (
    <div className={className ?? "openperps-launcher"}>
      <ol className="openperps-launcher-steps">
        {plan.steps.map((step, i) => (
          <li key={`${step.kind}-${i}`}>{step.kind}</li>
        ))}
      </ol>
      <button
        className="openperps-launcher-create"
        type="button"
        onClick={() => onLaunch?.(intent)}
      >
        Create {intent.symbol}
      </button>
    </div>
  );
}
