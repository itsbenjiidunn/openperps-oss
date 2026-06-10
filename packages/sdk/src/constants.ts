/// Canonical, public on-chain identifiers. These are not secrets (a program id is
/// readable by anyone on chain); they are sensible defaults so examples and the
/// integration scripts run against the known deployment out of the box. Always
/// allow an override (pass a `programId`, or read `OPENPERPS_PROGRAM_ID`) so a
/// consumer can point at their own deployment.

/// The canonical OpenPerps program deployed on devnet. Override per call or via
/// the `OPENPERPS_PROGRAM_ID` environment variable.
export const DEVNET_PROGRAM_ID = "2TGY1iY2r4MKytwg5vir9CJnJrqgdZrzjF8LjNaiVnZ4";
