# Arithmetic-axiom manifest (roadmap 3B.2)

Every `#[kani::stub(<helper>, <axiom>)]` in the proof suite replaces a production
wide-arithmetic helper with an OPAQUE specification axiom so the surrounding
composition is tractable in Kani. This manifest is the audit trail: each stub
names the opaque property assumed, the Kani proofs that consume it, and the
production-vs-axiom DISCHARGE (the differential test + its Tier-A bound / Tier-B
sampled domain). An axiom is sound ONLY if its discharge artifact is green.

Enforced by `scripts/arithmetic_axiom_manifest_check.py`: every
`#[kani::stub(...)]` target+axiom pair must appear as a row here, and every row
must name a present discharge artifact. No silent "opaque helper" drift.

## Stubbed helper: `crate::v16::loss_weight_for_basis`
Production: `loss_weight_for_basis(abs_basis_q, a_basis) =
ceil(abs_basis_q * SOCIAL_WEIGHT_SCALE / a_basis)` via U256 (wide multiply +
ceil-divide — Kani-intractable to symex; see no-steal-theorem.md).

| axiom stub | opaque property assumed | sound for | Kani proofs consuming it | discharge artifact |
|------------|-------------------------|-----------|--------------------------|--------------------|
| `kani_any_loss_weight` (v16_proofs.rs) | result is arbitrary, `w != 0` | FRAME only (WHERE fields land — value-irrelevant) | `composition_attach_body_frame_division_stubbed`, `composition_clear_leg_body_frame` | `loss_weight_helper_matches_division_axiom` + `loss_weight_axiom_holds_at_rounding_edges` |
| `axiom_loss_weight_nonzero` (v16_proofs.rs) | `a==0 => Err` (fail-closed, matching production); else `w != 0` | VALUE-conservation deltas (the body branches only on `w != 0`; the exact weight is the discharge's job) | `composition_attach_value_conservation_under_axiom`, `composition_clear_leg_value_conservation` | `loss_weight_helper_matches_division_axiom` + `loss_weight_axiom_holds_at_rounding_edges` |

### Discharge detail (production == axiom)
`tests/rounding_residue_fuzz.rs`:
- `loss_weight_helper_matches_division_axiom` — 20k cases: the production helper
  EQUALS `ceil(abs * SOCIAL_WEIGHT_SCALE / a_basis)` (the exact spec the opaque
  stub abstracts), so the composition's "some nonzero w" is, in production,
  exactly the spec ceil.
  - TIER-A (bounded exhaustive): rounding edges — `loss_weight_axiom_holds_at_
    rounding_edges` enumerates the rem-zero / rem-nonzero ceil boundary.
  - TIER-B (adversarial sampling): the 20k randomized cases over the real
    `a_basis ∈ [MIN_A_SIDE, ADL_ONE]`, `abs` production ranges.
- Property direction: the weight is CEILed (against the protocol's dilution
  exposure), never understated — consistent with spec req #14.

## Soundness boundary (stated)
- FRAME composition under `kani_any_loss_weight` is sound because a frame asserts
  only WHERE state is written, not its value — any nonzero weight lands in the
  same fields.
- VALUE composition under `axiom_loss_weight_nonzero` is sound because the body's
  control flow depends only on `w != 0`; the asserted conservation deltas use the
  opaque `w` symbolically, and the exact `w == ceil(...)` is supplied by the
  discharge fuzz (NOT re-derived in Kani — that would reintroduce the wide
  arithmetic, see the no-steal-theorem "corrected axiom" note).
- Trusted base for these compositions = `ArithmeticAxiom (loss_weight_for_basis
  == ceil spec)` + the differential discharge. Never claimed as "Kani proved the
  U256 implementation."

## Stubbed helper: `crate::v16::social_loss_book_split`
Production: `social_loss_book_split(engine_chunk, carried_rem, weight_sum) =
((engine_chunk*SOCIAL_LOSS_DEN + carried_rem) / weight_sum, ... % weight_sum)` —
the wide social-loss booking division (numerator scaled by SOCIAL_LOSS_DEN ~2^70).

| axiom stub | opaque property assumed | sound for | Kani proofs consuming it | discharge artifact |
|------------|-------------------------|-----------|--------------------------|--------------------|
| `axiom_social_loss_book_split` (v16_proofs.rs) | `weight_sum==0 => Err` (matches production); else result `(delta_b, new_rem)` arbitrary | SHELL only (booked_loss==engine_chunk, remaining_after+booked==residual, explicit_loss==0, delta_b>0) — none depend on the split VALUE | `contract_check_bresidual_chunk_conservation` | `social_loss_split_tier_a_exhaustive` + `social_loss_split_sampled` (reference_model_conformance.rs) |

- The conservation/no-explicit-loss/B-progress shell holds for ANY split output
  because apply_bankruptcy_residual_chunk_to_loss_side sets booked_loss=engine_chunk
  and remaining_after=residual_remaining-engine_chunk directly, and rejects
  delta_b==0 (-> None). The split's exact (delta_b,new_rem) value is the discharge
  fuzz's job, never re-derived in Kani (would reintroduce the wide division).
