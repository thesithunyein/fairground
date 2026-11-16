// FAIRGROUND as a Chain.wtf graph-engine title: one fair ladder per paint composition.
//
// The chain, the frontend and scripts/check-title.ts all import this one module, so the
// numbers the engine settles with are the numbers the booth shows.
//
// Self-contained on purpose: type-only imports, erasable TypeScript only, so `chain dev`
// and the developer platform can load it with Node's own type stripping.
import type { GraphGameDefinition, LadderNode } from '@chain-protocol/casino-sdk/graph-engine';

/** Prizes are whole multiples of 1/PRIZE_DENOMINATOR of the wager. */
export const PRIZE_DENOMINATOR = 1_000_000n;
/**
 * The ladder's base prize: 0.96x. A fair ladder's value is exactly its base prize, so this is
 * where the house edge lives. The engine therefore reports RTP 96.00% for every configuration.
 */
export const BASE_PRIZE = 960_000n;
/**
 * The entry and every ride are fair steps over this denominator. Equal to BASE_PRIZE, so an
 * entry ratio of `p` cashes out at `p` prize units: the wheel's floored prize.
 */
export const RATIO_DENOMINATOR = BASE_PRIZE;
/** No cash-out may reach 100x; the engine refuses a ride whose win would. */
export const CAP_PRIZE = 100n * PRIZE_DENOMINATOR;
/** The safe anchor, 0.2x. */
export const SAFE_PRIZE = PRIZE_DENOMINATOR / 5n;

/** Wheel sizes the booth offers: even, 8 to 16 slices. */
export const SEGMENT_COUNTS = [8, 10, 12, 14, 16] as const;

/**
 * One label per meaning, shared with the frontend. The entry draws SAFE, MID or RISKY; a ride
 * draws WIN or LOSE. RIDE labels the ride option itself.
 */
export const LABEL = { safe: 0, mid: 1, risky: 2, win: 3, lose: 4, ride: 5 } as const;

/** At the only rung: option 0 rides, and the option count (1) cashes out. */
export const ACTION_RIDE = 0;
export const ACTION_BANK = 1;

export type Composition = { n: number; cSafe: number; cMid: number; cRisky: number };
export type EntryPrizes = { safe: bigint; mid: bigint; risky: bigint };

/**
 * Every legal paint composition, in configuration order: N ascending, then cRisky, then cMid,
 * the same order scripts/ladder-math.mjs walks. Legal means cRisky >= 1, cSafe + cMid >= 1 and
 * 2·cRisky <= N. 300 configurations.
 */
export const COMPOSITIONS: readonly Composition[] = (() => {
  const list: Composition[] = [];
  for (const n of SEGMENT_COUNTS) {
    for (let cRisky = 1; 2 * cRisky <= n; cRisky++) {
      for (let cMid = 0; cMid + cRisky <= n; cMid++) {
        const cSafe = n - cRisky - cMid;
        if (cSafe + cMid < 1) continue;
        list.push({ n, cSafe, cMid, cRisky });
      }
    }
  }
  return list;
})();

const compositionKey = (c: Composition) => `${c.n}:${c.cSafe}:${c.cMid}:${c.cRisky}`;
const CONFIGURATION_OF = new Map(COMPOSITIONS.map((c, i) => [compositionKey(c), i]));

/** The bet configuration that plays this composition, or -1 when it is not legal. */
export function configurationOf(c: Composition): number {
  return CONFIGURATION_OF.get(compositionKey(c)) ?? -1;
}

/**
 * The wheel's prizes in prize units, floored: SAFE = 0.2x, MID = 2λ, RISKY = 6λ with
 * λ = (0.96·N − 0.2·cSafe) / (2·cMid + 6·cRisky). Without the floor every composition would
 * return exactly 96%; the floor keeps each a hair under it.
 */
export function entryPrizes(c: Composition): EntryPrizes {
  const lambdaNumerator = (96n * BigInt(c.n) * PRIZE_DENOMINATOR) / 100n - SAFE_PRIZE * BigInt(c.cSafe);
  const lambdaDenominator = BigInt(2 * c.cMid + 6 * c.cRisky);
  return {
    safe: SAFE_PRIZE,
    mid: (2n * lambdaNumerator) / lambdaDenominator,
    risky: (6n * lambdaNumerator) / lambdaDenominator,
  };
}

/**
 * The ladder for one composition. The entry is the wheel: SAFE, MID and RISKY weighted by their
 * slice counts. Its mean ratio is a hair under RATIO_DENOMINATOR, so it is a fair step to within
 * the engine's 1/10,000. A zero weight is not allowed, so a wheel with no mid slice has no MID
 * outcome. The one rung offers a single ride: a 50/50 double-or-nothing, exactly fair.
 */
export function ladderOf(c: Composition): LadderNode {
  const p = entryPrizes(c);
  const entry: LadderNode['entry'] = [];
  if (c.cSafe > 0) entry.push({ weight: BigInt(c.cSafe), ratio: p.safe, rung: 0, label: LABEL.safe });
  if (c.cMid > 0) entry.push({ weight: BigInt(c.cMid), ratio: p.mid, rung: 0, label: LABEL.mid });
  entry.push({ weight: BigInt(c.cRisky), ratio: p.risky, rung: 0, label: LABEL.risky });
  return {
    kind: 'ladder',
    basePrize: BASE_PRIZE,
    capPrize: CAP_PRIZE,
    ratioDenominator: RATIO_DENOMINATOR,
    entry,
    rungs: [
      {
        canCashOut: true,
        options: [
          {
            label: LABEL.ride,
            outcomes: [
              { weight: 1n, ratio: 2n * RATIO_DENOMINATOR, rung: 0, label: LABEL.win },
              { weight: 1n, ratio: 0n, rung: 0, label: LABEL.lose },
            ],
          },
        ],
      },
    ],
  };
}

const fairground: GraphGameDefinition<Composition> = {
  prizeDenominator: PRIZE_DENOMINATOR,
  roots: [...COMPOSITIONS],
  key: compositionKey,
  expand: ladderOf,
};

export default fairground;
