/// Registry of launch providers for the aggregator UI. OpenPerps is the intermediary; the
/// dev picks one of these as the token origin, and the aggregator flow adds the perp.

import type { LaunchProvider, LaunchProviderId } from "./types";
import { nativeProvider } from "./native";
import { pumpfunProvider, bonkProvider } from "./pumpportal";

export const LAUNCH_PROVIDERS: LaunchProvider[] = [nativeProvider, pumpfunProvider, bonkProvider];

export function getLaunchProvider(id: LaunchProviderId): LaunchProvider {
  const provider = LAUNCH_PROVIDERS.find((p) => p.id === id);
  if (!provider) throw new Error(`Unknown launch provider: ${id}`);
  return provider;
}
