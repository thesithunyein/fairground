# FAIRGROUND · Declared Math & RTP Verification

> **Game:** FAIRGROUND, the honest carnival. Paint your prizes, ride a fair ladder.
> **Runs on:** the Chain.wtf **graph engine**, as a title of 300 fair ladders: `src/title.ts`. There is no game contract of our own.
> **RTP ≈ 96%**: the engine reports **96.00%** for every configuration; the floored prizes it actually pays return **95.9999% to 96.0000%**. Section 4 explains the gap, which never favours the player.

## 1. The round

```
open      encodePlainGameData(configuration, paintTail)   the engine requests word 1
word 1    the ladder's ENTRY: the wheel draws SAFE, MID or RISKY            → waiting at the rung
RIDE      actionData = abi.encode(uint256 0)                 the engine requests word k
word k    the ride: WIN doubles the hold, LOSE pays 0 and settles            → waiting at the rung, or settled
BANK      actionData = abi.encode(uint256 1)                 settles at once, no word needed
```

- The player can RIDE again and again. The engine refuses a ride whose win would bring the cash-out to the **100x cap**, and once no ride is left it settles the session at the cash-out by itself.
- **Each ride's word does not exist when the player decides.** It is requested by the RIDE action itself, so the coin cannot be read out of an earlier word.
- A session reserves only what its **next step** can win (the engine's `stepNet`), so a long ride ties up little liquidity at its start.

## 2. What the player paints

Each slice gets a tier: `SAFE`, `MID` or `RISKY`. A paint is **legal** iff, with `N ∈ {8, 10, 12, 14, 16}` slices:

1. `cRisky ≥ 1`, so there is something to win
2. `cSafe + cMid ≥ 1`, so there is a cushion
3. `2·cRisky ≤ N`, so risky covers at most half the wheel

The payout only depends on the **composition** `(N, cSafe, cMid, cRisky)`, not on where the slices sit. There are **300** legal compositions, and each one is a bet configuration of the title, in the order `scripts/ladder-math.mjs` walks them (N, then cRisky, then cMid). The slice layout rides in the game data's tail: the engine ignores it, and the booth uses it only to draw the wheel.

## 3. Pricing · one equation

Let `(cS, cM, cR)` be the tier counts. RTP 96% means:

```
0.96·N = SAFE·cS + MID·cM + RISKY·cR
```

Three unknowns, one equation, so fix an **anchor** and derive a **scale**:

```
SAFE  = 0.2               (anchor: a fifth of the stake back)
MID   = 2λ
RISKY = 6λ
λ = (0.96·N − 0.2·cS) / (2·cM + 6·cR)
```

Each prize is then **floored to a whole prize unit**, a millionth of the wager (`prizeDenominator = 1,000,000`).

**Ordering.** Over every legal paint `λ ≥ 0.24` (at `N = 8, cS = 0, cM = 4, cR = 4`: `7.68 / 32`); rule 3 is what holds it up. So `SAFE = 0.2 < MID ≥ 0.48 < RISKY ≥ 1.44` on every paint.

**Largest prize.** `N = 16, cS = 15, cM = 0, cR = 1` gives `λ = 2.06`, so `RISKY = 12.36x`.

## 4. The ladder, and why the engine says 96.00% while the prizes return ≈96%

Each configuration is one **fair ladder** node:

| Field | Value | Why |
|---|---|---|
| `basePrize` | 960,000 (0.96x) | a fair ladder's value is exactly its base prize, so the house edge lives here |
| `ratioDenominator` | 960,000 | equal to `basePrize`, so an entry ratio of `p` cashes out at exactly `p` prize units |
| `entry` | SAFE, MID, RISKY with weights `cS, cM, cR` and ratios = the floored prizes | the wheel; MID is left out when `cM = 0`, because the engine allows no zero weight |
| `rungs[0]` | one option, RIDE: WIN ratio 2 (`1,920,000`), LOSE ratio 0, weight 1 each | an exact double-or-nothing |
| `capPrize` | 100,000,000 (100x) | no cash-out reaches 100x |

**The engine's derive checks every step of a ladder for fairness:** a step's mean ratio may not be above `ratioDenominator`, and may fall below it by at most 1/10,000. That covers the ride (exactly fair) and the **entry** too. So the house edge cannot sit in the wheel's prizes. It sits in `basePrize` = 0.96x, and the wheel's entry is a fair step around it.

That is also why the two RTP figures differ:

- **The engine reports 96.00% for every configuration.** It derives a fair ladder's value as `basePrize`, by definition, and does not look at how far below fair the entry falls inside the 1/10,000 tolerance.
- **The floored prizes return 95.9999% to 96.0000%.** Flooring each prize to a whole prize unit leaves the entry's mean ratio a hair under fair, at most 0.0001 percentage points of RTP. `scripts/check-title.ts` asserts the gap for all 300 configurations: always ≥ 0, never more than 0.0001 points.
- **Paid amounts can sit one base unit under the floored prize.** The engine holds the banked multiplier in 1e18 fixed point as `floor(1e18 × prize / 960,000)`. Because 0.96 has a factor of 3, that is exact only for prizes divisible by 3, so a cash-out pays `floor(wager × prize / 1e6)` **or one base unit less**, never more. Example: a 1.000000 chUSD bet that lands the 0.2x SAFE slice pays 0.199999. The check tests every tier of every configuration at every ride depth over eight wagers: 31,052 exact, 18,412 one unit under, none over.

Every difference is a rounding remainder that stays with the house, a millionth of the wager or less. The booth says **RTP ≈96%** and shows the paint's exact floored figure in **Why this stays fair**.

## 5. The rides · the fairness of each one is enforced on-chain

At the rung the player holds the cash-out `wager × m`. They may:

```
BANK → payout = wager · m
RIDE → hold becomes 2m   with probability 1/2   (and the player may ride again)
       payout 0          with probability 1/2
```

`E[ride] = ½·2m + ½·0 = m = E[bank]`, so every ride is a **pure variance choice**: a player who always banks and a player who rides to the cap both return the same ≈96%. This is not a claim we ask anyone to trust:

- **The chain enforces it.** The graph engine's derive refuses a title with any ladder step that pays above fair or more than 1/10,000 below it, and takes the **best play at every decision** when it computes RTP. A ride with an edge either way could not have deployed.
- **The cap is enforced too.** The engine refuses a ride whose win would reach 100x, and derive refuses a ladder whose entry could reach the cap. Rides allowed after a landing: 8 on the 0.2x SAFE slice, and 3 to 6 on a RISKY slice depending on the paint (3 on the 12.36x slice: `12.36 → 24.72 → 49.44 → 98.88`).
- **The approval ceiling is met.** The title's highest RTP is 96.00% ≤ 98%, so it is whitelisted the moment it deploys.

## 6. What the booth shows, and what it decides

Nothing. The frontend never decides an outcome or a payout: the engine settles every session from the compiled graph and the VRF words.

- **The wheel.** The booth replays every word with the SDK's `walkLadder`, the engine's own walk. The entry label says which tier the engine drew. Which slice of that tier the pointer stops on is chosen from the same word under its own domain, `keccak256(word ‖ "fairground:slice") mod (slices of that tier)`. Every slice of the tier pays the same, so this is purely cosmetic, and it is deterministic, so anyone can recompute it.
- **The hold** is shown as the floored prize doubled once per ride won (a SAFE landing reads 0.20×), and the amount as exactly what the engine pays, to the base unit (a 1 chUSD bet on that slice holds 0.199999 chUSD). The booth never rounds a payout up.
- **Rides left** come from the cap: the booth counts how many doublings the engine's own cap rule (`ladderOptionPassesCap`) still allows from the current hold.
- **Prize drops** are cosmetic too: `keccak256(word ‖ "fairground:prize")` gives the toy (`mod 6`) and its rarity (low byte `< 196` common, `< 246` rare, else legendary: 76.6 / 19.5 / 3.9%). Nothing on the payout path reads them.

## 7. Verification

| Command | What it proves |
|---|---|
| `npm run check:math` | `scripts/ladder-math.mjs 1000000 100`: the reference math for all 300 compositions, without the SDK. Floored RTP 95.9999–96.0000%, every configuration ≤ 98% and < 100%, no entry at the cap, cap ≥ 2x the base |
| `npm run check:title` | `scripts/check-title.ts`: compiles `src/title.ts` with the SDK's `compileGraphGame`, the compiler the platform runs, and holds every configuration to `ladder-math.mjs`: the same compositions and floored prizes to the prize unit; engine RTP ≤ 98% and within 0.0001 points above the floored RTP; every cash-out at every ride depth equal to the floored prize or one base unit under, never over; the rides the cap allows per tier equal to `ladder-math.mjs`'s; quoted expected payout 0.96x; 3,000 random `walkLadder` sessions settling as the floored prizes say |
| `node scripts/e2e-ladder.ts [n]` | with `npm run simulator` running: opens `n` real sessions on the deployed title, RIDEs and BANKs through `submitAction`, waits for the local VRF node, and checks each settlement against `walkLadder`, the floored prizes and the player's token balance |
| `npm run verify:missions` | the daily objectives and ladder are pure, cosmetic logic |
