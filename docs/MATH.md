# FAIRGROUND · Declared Math & RTP Verification

> **Game:** FAIRGROUND, the honest carnival. Paint your prizes, the wheel stays fair.
> **Entry:** Chain Jam Vol. 1 (jam.chain.wtf) · Contract: `contract/FairgroundWheel.sol`
> **Declared theoretical RTP: 96.00%** (eligibility window 93–98%), held for **every legal paint**, by construction.

## 1. The wheel

- `N` segments, `N ∈ {8, 10, 12, 14, 16}` (even). The VRF word is mapped to a segment with **rejection sampling**: `limit = floor(256/N)·N`; the first byte `b < limit` gives `segment = b % N`. This is **exactly uniform**, with no modulo bias (RANDOMNESS_DICE.md rules). If all 32 bytes were rejected (p < 2⁻³²⁰, never observed), the fallback is `uint256(randomness) % N`, mirrored identically in client and contract.

## 2. What the player paints

Each segment gets a **tier**: `0 = SAFE`, `1 = MID`, `2 = RISKY`. Tiers only change **payouts**, never probabilities. A paint is **legal** iff:

1. every tier ≤ 2
2. `cRisky ≥ 1`, so there is something to win
3. `cSafe + cMid ≥ 1`, so there is a cushion
4. `2·cRisky ≤ N`, so risky covers at most half the wheel

## 3. Pricing · one equation, RTP exactly 96%

Let `(cS, cM, cR)` be the tier counts. By definition of RTP:

```
RTP·N = SAFE·cS + MID·cM + RISKY·cR
```

Three unknowns, one equation → fix an **anchor** and derive a **scale**:

```
SAFE = 0.2              (anchor, always pays a fifth of the stake back)
MID   = 2λ               (derived)
RISKY = 6λ               (derived)

λ = (RTP·N − 0.2·cS) / (2·cM + 6·cR)     (floored to WAD)
```

Because there is exactly **one** linear equation and exactly **one** free variable λ, **every legal paint returns exactly 96% before floor rounding.** The floor remainder (≤ a few thousandths of a cent per spin) goes to the house, so realized RTP is **at least 93% and at most 96.00%**, always inside the declared window, and the verifier shows it at ≈ 95.99–96.00%.

**Ordering guarantee.** On the legal space, `λ ≥ 0.24` in WAD terms:

- worst case for λ: `N = 8, cS = 0, cM = 3, cR = 5` → wait, that violates rule 4 (`2·5 > 8`); the true worst cases are `cM = 3, cR = 1..4` with N = 8; the minimum of `(0.96·8 − 0.2·cS)/(2·cM + 6·cR)` over all legal paints is **0.24**, reached at `N=8, cS=0, cM=4, cR=4` → `7.68/32 = 0.24`.

Therefore on every legal paint: `SAFE = 0.2 < MID = 2λ ≥ 0.48 < RISKY = 6λ ≥ 1.44`. Safe is always the cushion, risky always pays at least 1.44×. No edge cases exist.

**Maximum multiplier.** The heaviest legal paint is `N=16, cR=1, cM=0, cS=15` → `λ = (15.36 − 3)/6 = 2.06` → `RISKY = 12.36×`. Global max ≈ **12.36×**.

## 4. Vault risk (heavy-tail analysis)

The facet triggers the tiered jackpot-reserve path when `maxPayout/wager > 100` **and** win probability < 0.1%. FAIRGROUND's worst case: multiplier 12.36× (< 100) and risky probability ≥ 1/16 = 6.25% (≥ 0.1%). **Both thresholds are comfortably unmet → simple single-tier VaR path**, `subJackpotVarianceScaled = 0`.

`quoteRiskParams` declared vs actual:

| Quantity | Declared | Actual (onRandomness) |
|---|---|---|
| `maxPayout` | `wager · RISKY / WAD` | risky-tier payout, the maximum of the three tiers |
| `probabilityWad` | `cRisky·WAD / N` | exactly the chance the landed segment is risky |
| `expectedPayout` | `wager · 0.96` | exact expectation of the payout distribution |

## 5. Cosmetic prize roll (payout-neutral)

The byte **after** the accepted segment byte (or the segment byte itself if it was last) is the **prize roll**: `toyId = b % 6`; rarity by value: `b < 196` common (76.6%), `b < 246` rare (19.5%), else legendary (3.9%). The payout path reads **only** the segment byte; `scripts/verify-rtp.mjs` proves payout invariance over the prize byte's full range.

## 6. Verification

`npm run verify:rtp` proves, over **every legal paint**:

1. pricing identity `RTP·N = Σ multᵢ` holds up to floor remainder (remainder < N·WAD/1000)
2. ordering `0.2 < MID < RISKY` and `RISKY ≥ 1.44`
3. multiplier cap ≤ 16× (contract constant), real max ≈ 12.36×
4. heavy-tail thresholds unmet (multiplier < 100×, risky prob ≥ 0.1%)
5. floor-truncated RTP ∈ [93%, 98%] for every paint
6. Monte-Carlo (≥ 200k spins over randomized legal paints): empirical RTP ∈ window
7. prize-byte invariance: payout identical for all 256 prize rolls
8. rejection-sampling uniformity: χ²-style bucket check within tolerance
