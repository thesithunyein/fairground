# FAIRGROUND · Declared Math & RTP Verification

> **Game:** FAIRGROUND, the honest carnival. Paint your prizes, the wheel stays fair.
> **Entry:** Chain Jam Vol. 1 (jam.chain.wtf) · Contract: `contract/FairgroundWheel.sol`
> **Declared theoretical RTP: 96.00%** (eligibility window 93–98%), held for **every legal paint** and for **every strategy**, by construction.

## 1. The round

Three steps, two VRF words:

```
1. open            onSessionStart   → WAITING_RANDOMNESS    word A: the segment
2. word A          onRandomness     → WAITING_PLAYER_ACTION
3. BANK or RIDE    onPlayerAction   → SETTLED               (bank)
                                    → WAITING_RANDOMNESS    (ride)
4. word B          onRandomness     → SETTLED               the ride coin
```

- `N` segments, `N ∈ {8, 10, 12, 14, 16}` (even). A word is mapped to a segment with **rejection sampling**: `limit = floor(256/N)·N`; the first byte `b < limit` gives `segment = b % N`. This is **exactly uniform**, with no modulo bias (RANDOMNESS_DICE.md rules). If all 32 bytes were rejected (p < 2⁻³² per word, never observed), the fallback is `uint256(randomness) % N`, mirrored identically in client and contract.
- **Word B does not exist when the player decides.** That is the whole point of the extra step: the ride coin must be unpredictable at decision time, or a player (or a script) could read it out of the session's first word and ride only when it wins.

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

**Ordering guarantee.** On the legal space, `λ ≥ 0.24`:

- the minimum of `(0.96·N − 0.2·cS)/(2·cM + 6·cR)` over every legal paint is **0.24**, reached at `N = 8, cS = 0, cM = 4, cR = 4` → `7.68/32 = 0.24`.
- rule 4 (`2·cR ≤ N`) is what holds this floor up: it excludes paints such as `N = 8, cM = 3, cR = 5`, where risky would cover 62.5% of the wheel and λ would fall to `7.68/36 ≈ 0.213`.

Therefore on every legal paint: `SAFE = 0.2 < MID = 2λ ≥ 0.48 < RISKY = 6λ ≥ 1.44`. Safe is always the cushion, risky always pays at least 1.44×. No edge cases exist.

**Maximum multiplier.** The heaviest legal paint is `N=16, cR=1, cM=0, cS=15` → `λ = (15.36 − 3)/6 = 2.06` → `RISKY = 12.36×`. Global base-tier max ≈ **12.36×**.

## 4. The ride · an exactly fair coin, so the edge never moves

After word A the player holds a real amount — the landed segment's multiplier `m`. They may:

```
BANK  → payout = wager · m
RIDE  → payout = 2 · wager · m   with probability 1/2
                 0                otherwise
```

`E[ride] = ½·2m + ½·0 = m = E[bank]`. The optional step is therefore a **pure variance choice with zero house edge**:

- `E[payout] = wager · 0.96` for **every legal paint and every strategy**, so the declared `expectedPayout` is honest whatever the player does. The game carries no "under optimal play" caveat.
- The ride is priced in nothing, because it costs nothing in expectation. A player who always banks and a player who always rides both return exactly 96%.

**Maximum round payout.** The ride doubles the heaviest tier, so the worst case is `2 × 12.36× = 24.72×`, and `probabilityWad` (the probability of that top payout) is `cRisky/N · ½`, at minimum `1/16 · ½ = 3.125%`.

## 5. Vault risk

The facet triggers the tiered jackpot-reserve path when `maxPayout/wager > 100` **and** win probability < 0.1%. FAIRGROUND's worst case: round multiplier 24.72× (< 100) and top-payout probability ≥ 3.125% (≥ 0.1%). **Both thresholds are comfortably unmet → the simple VaR path**, with no σ floor required.

Because the host commits risk *before* the player chooses, every declared quantity is the **worst case over the player's choices** (i.e. the player rides). A riding player is the expensive one: they double the worst tier and halve its probability.

`quoteRiskParams` declared vs actual:

| Quantity | Declared | Actual (onRandomness) |
|---|---|---|
| `maxPayout` | `RIDE_FACTOR · wager · RISKY / WAD` | the doubled risky payout, the maximum over both choices |
| `probabilityWad` | `cRisky·WAD / (2N)` | exactly the chance the top payout lands (heaviest tier **and** a winning coin) |
| `expectedPayout` | `wager · 0.96` | exact expectation of the payout distribution, for every strategy |
| `bodyVarianceScaled` | `X²·cMid·(2N−cMid)·1e18 / N²` | variance of the payout with the top tier removed (below) |

`quoteCaps` and `onSessionStart` reserve against the same `maxPayout`, and every payout — quote, bank, ride win, ride loss — is computed through the single `_payoutFor` expression, so the reserve and the paid amount agree to the wei (see CONTRACT_CONSTRAINTS.md's "reserve and payout must agree to the wei").

**Body variance (the fourth parameter).** `ICasinoGameV2` defines `bodyVarianceScaled` as the
variance of this bet's payout **with the top tier removed**, per bet, in wei²·1e18. It is added
to the top-tier binary variance for every bet, heavy-tail or not, and a game whose top tier is the
sole winning outcome returns `0`. The excluded tier is exactly the one whose probability is
reported as `probabilityWad`, which is what keeps the on-chain binary term and this body term
from double counting.

The top tier is RISKY here, so the removal leaves SAFE and MID:

- SAFE pays at most `2 × 0.2 = 0.4×` even when doubled, so it is never a winning outcome;
- MID is a second winning outcome exactly when its **doubled** payout beats the stake, i.e.
  `2·(2λ) > 1`, i.e. `λ > 0.25`.

Taken under the worst-case policy (the player rides), the surviving payout is the doubled mid
multiplier behind two independent, unbiased flips — `B ~ Bernoulli(p)` that MID is landed with
`p = cMid/N`, and `K ~ Bernoulli(½)` that the fair ride wins, with `E[K] = 1` and
`E[K²] = ½·RIDE_FACTOR² = 2`. Writing `X` for the mid payout:

```
E[BKX] = Xp          E[(BKX)²] = 2X²p
Var    = 2X²p − X²p² = X²·p·(2 − p) = cMid·(2N − cMid)·X² / N²
```

Dropping the ride's coin (`K ≡ 1`) recovers the bank-only form `p(1−p)·X²`, so this is the same
measure with the ride folded in. `2λ > 0.5` holds on the safe-heavy paints — **259 of the 300
legal composition classes** — so the contract computes this per paint rather than hardcoding zero.
`scripts/verify-rtp.mjs` recomputes it from an independent brute-force enumeration of all `2N`
(segment, coin) outcomes for every legal class and asserts the contract's arithmetic agrees.

## 6. Cosmetic prize roll (payout-neutral)

The byte **after** the accepted segment byte (or the segment byte itself if it was last) is the **prize roll**: `toyId = b % 6`; rarity by value: `b < 196` common (76.6%), `b < 246` rare (19.5%), else legendary (3.9%). The payout path reads **only** the segment byte; `scripts/verify-rtp.mjs` proves payout invariance over the prize byte's full range. The ride never touches the prize roll, so a ridden round still drops exactly one toy.

## 7. Forfeit quote

`quoteForfeitPayout` may only quote value already determined by revealed state, or it becomes an
adverse-selection exploit against the vault (CONTRACT_CONSTRAINTS.md). The host can only forfeit a
session in `WAITING_PLAYER_ACTION` — exactly the step where the segment is known and BANK is
available — so the contract quotes **that bankable amount**, and returns `0` while a ride is in
flight, where the value genuinely depends on unresolved randomness.

## 8. Verification

`npm run verify:rtp` proves, over **every legal paint**:

1. pricing identity `RTP·N = Σ multᵢ` holds up to floor remainder (remainder < N·WAD/1000)
2. ordering `0.2 < MID < RISKY` and `RISKY ≥ 1.44`
3. multiplier cap ≤ 16× on one tier (contract constant), real base max ≈ 12.36×
4. heavy-tail thresholds unmet on the **round** worst case too (24.72× < 100×, top payout ≥ 3.125% ≥ 0.1%)
5. floor-truncated RTP ∈ [93%, 98%] for every paint
6. Monte-Carlo (≥ 200k spins over randomized legal paints), for a **banking** and a **riding** player: both empirical RTPs ∈ window
7. prize-byte invariance: payout identical for all 256 prize rolls
8. rejection-sampling uniformity: χ²-style bucket check within tolerance
9. `bodyVarianceScaled` agrees with the closed form `cMid·(2N−cMid)·X²·1e18 / N²` on every legal class, is positive exactly when the doubled mid beats the stake, and is zero when the risky tier is the only winning outcome
10. **the ride is exactly fair**: enumerating all `2N` (segment, coin) outcomes for every class, banking and riding have the same expectation, and it is the declared 96%

`scripts/e2e-round.mjs` drives the real local host (chain + Verify Network VRF) through a banked
round, a ridden round in **both** coin outcomes, the declared quotes and the forfeit quote.
