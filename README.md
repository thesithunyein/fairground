# 🎡 FAIRGROUND — the honest carnival

> **Paint your prizes. The wheel stays fair.**

A Chain Jam Vol. 1 entry ([jam.chain.wtf](https://jam.chain.wtf)). FAIRGROUND is a
carnival prize wheel where the *probabilities are never negotiable* — one VRF word,
rejection-sampled to an exactly-uniform segment — but **the paytable is yours**.
Paint each segment safe, mid, or risky before every spin; the contract derives the
multipliers so the wheel returns **exactly 96% RTP no matter how you paint it**.
Every spin also drops a carnival prize for your shelf; fill sets, unlock liveries.

## Why it's different

| Every other wheel | FAIRGROUND |
|---|---|
| Fixed paytable chosen by the house | Paytable painted by **you**, recomputed on-chain from your paint |
| "Trust our math" | RTP is *proven* at 96.000% for **every legal paint** (see below) |
| Fairness as a checkbox | The wheel is uniform **by construction** — auditable in 2 minutes |

The house can't cheat a paytable that's derived on-chain from your own paint.

## Provably fair, provably 96%

- **Uniform wheel:** `limit(N) = ⌊256/N⌋·N`; the first VRF byte under `limit` maps to
  `byte % N` — exactly uniform, zero modulo bias (rejection sampling per
  `RANDOMNESS_DICE`).
- **RTP locked at 96% for any paint:** tiers price as `SAFE = 0.2×`,
  `MID = 2λ`, `RISKY = 6λ` with
  `λ = (0.96·N − 0.2·cSafe) / (2·cMid + 6·cRisky)` — one linear equation, so every
  legal paint prices to exactly 96%.
- **Verified:** `npm run verify:rtp` sweeps all 300 composition classes of the legal
  paint space (pricing identity, tier ordering, multiplier bounds, heavy-tail
  thresholds, RTP window) + Monte-Carlo over ~2M simulated spins
  (empirical RTP 95.85% ± noise) + prize-invariance (payout identical with the
  collection path enabled/disabled). Full math: [`docs/MATH.md`](../docs/MATH.md).
- **Contract authoritative:** the client's preview mirrors the Solidity integer math
  bit-for-bit; the contract trusts nothing from the browser.

## SDK compliance

- `contract/FairgroundWheel.sol` implements `ICasinoGameV2` (instant shape:
  open → WAITING_RANDOMNESS → SETTLED; no player actions).
- Frontend talks to the host **only** through the SDK bridge (`src/chain-sdk/`);
  zero wallet code.
- `public/game.manifest.json` declares the game.
- **E2E-proven on the local simulator** (real VRF node): three full
  bet → VRF fulfillment → settlement rounds, one per tier, payouts matching declared
  math to the wei (`scripts/e2e-round.mjs`).
- **Standalone demo mode:** opened outside the chain.wtf host, the bridge handshake
  never resolves and the game boots a self-contained demo (seeded PRNG rounds,
  simulated balance, labeled "DEMO").
- Jam widget tag is in `index.html` (`jam.chain.wtf/widget.js`).

## The carnival

- **Paint** — tap segments to cycle safe/mid/risky; the LCD shows your live
  multipliers and 96.00% RTP.
- **Spin** — ratchet ticks, near-miss wobble, wooden clack; three payout tiers.
- **Prize shelf** — every spin drops one of 18 pixel prizes (6 toys × 3 rarities,
  declared byte-range odds); complete sets to unlock booth liveries.
  Cosmetics live in localStorage; no accounts. Prizes are payout-neutral by design.

## Develop

```bash
npm install
npm run dev            # http://localhost:5173 (demo mode without the host)

npm run verify:rtp     # exhaustive + Monte-Carlo RTP proof
# simulator E2E: start the SDK simulator (npm start in the casino-sdk), then:
node scripts/e2e-round.mjs
```

Deploy: `npm run build` → host `dist/` on any static host. Near-instant load
(≈59 KB gzipped total, self-hosted fonts, zero images — everything is SVG/CSS).

## Tech

Vite + React + TypeScript, viem, WebAudio-synthesized sound kit, hand-drawn SVG
booth. Solidity ^0.8.30 on the Chain casino SDK (ICasinoGameV2 + bridge +
manifest). AI was used for code; the taste is ours.
