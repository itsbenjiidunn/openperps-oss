#!/usr/bin/env bash
# On-chain integration suite: build the program, spin up a local solana-test-validator,
# deploy, and run every integration script against it, then tear the validator down.
#
# This is the automated runtime test that host (buffer-level) tests cannot cover:
# SPL token CPI, PDA creation, and the on-chain handler <-> SDK account contract.
#
# Usage:
#   scripts/run-onchain-suite.sh            # build + run the full suite
#   SKIP_BUILD=1 scripts/run-onchain-suite.sh   # reuse an existing target/deploy/*.so
#
# Requires the Solana toolchain (solana, cargo-build-sbf, solana-test-validator) on
# PATH. On Windows native, the platform-tools rust must be >= 1.79 (see docs); on
# Linux/CI the default toolchain works.
set -u
cd "$(dirname "$0")/.."
ROOT=$(pwd)
SO="$ROOT/target/deploy/openperps_program.so"
LEDGER="${TMPDIR:-/tmp}/openperps-onchain-suite"
RPC="http://127.0.0.1:8899"
PROGRAM_ID="2TGY1iY2r4MKytwg5vir9CJnJrqgdZrzjF8LjNaiVnZ4"
PAYER="$LEDGER/payer.json"

SCRIPTS=(
  "packages/sdk/scripts/integration.ts"
  "packages/sdk/scripts/core-integration.ts"
  "packages/sdk/scripts/hlp-integration.ts"
  "packages/sdk/scripts/inslp-integration.ts"
  "packages/sdk/scripts/spread-integration.ts"
  "packages/sdk/scripts/coin-margin-integration.ts"
  "packages/sdk/scripts/launchpad-integration.ts"
  "packages/sdk/scripts/timelock-integration.ts"
)

log() { echo "[suite] $*"; }
VALIDATOR_PID=""
cleanup() { [ -n "$VALIDATOR_PID" ] && kill "$VALIDATOR_PID" 2>/dev/null; }
trap cleanup EXIT

# 1. Build the program (.so) unless skipped.
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  # The local suite runs the devnet-shaped program (mock price toy + raw Trade).
  # Production is now the default build, so enable devnet explicitly here.
  log "building program (cargo build-sbf --features devnet)..."
  cargo build-sbf --manifest-path crates/program/Cargo.toml --features devnet \
    || { log "BUILD FAILED"; exit 1; }
fi
[ -f "$SO" ] || { log "missing $SO (build it first or unset SKIP_BUILD)"; exit 1; }

# 2. Fresh ledger + a throwaway payer funded at genesis (no airdrop/keys needed).
mkdir -p "$LEDGER"
solana-keygen new -o "$PAYER" --no-bip39-passphrase --silent --force >/dev/null 2>&1
PAYER_PUB=$(solana-keygen pubkey "$PAYER")
log "throwaway payer=$PAYER_PUB"

# 3. Start the validator (genesis-fund the payer via --mint), wait for RPC.
log "starting solana-test-validator..."
solana-test-validator --reset --ledger "$LEDGER/ledger" --mint "$PAYER_PUB" >/dev/null 2>&1 &
VALIDATOR_PID=$!
for i in $(seq 1 60); do
  solana cluster-version --url "$RPC" >/dev/null 2>&1 && break
  sleep 1
done
solana cluster-version --url "$RPC" >/dev/null 2>&1 || { log "validator did not come up"; exit 1; }
log "validator up; payer balance=$(solana balance "$PAYER_PUB" --url "$RPC")"

# 4. Deploy the program (the program keypair pins the canonical id).
log "deploying program..."
solana program deploy "$SO" --url "$RPC" --keypair "$PAYER" --fee-payer "$PAYER" >/dev/null 2>&1 \
  || { log "DEPLOY FAILED"; exit 1; }
log "deployed $PROGRAM_ID"

# 5. Run each integration script; collect pass/fail.
export OPENPERPS_PROGRAM_ID="$PROGRAM_ID"
export OPENPERPS_RPC="$RPC"
export OPENPERPS_PAYER="$PAYER"
FAIL=0
for s in "${SCRIPTS[@]}"; do
  echo ""
  log "running $s"
  if node --import tsx "$s"; then
    log "OK   $s"
  else
    log "FAIL $s"
    FAIL=1
  fi
done

echo ""
if [ "$FAIL" = "0" ]; then
  log "ALL ON-CHAIN SUITE SCRIPTS PASSED"
else
  log "SUITE HAD FAILURES"
fi
exit "$FAIL"
