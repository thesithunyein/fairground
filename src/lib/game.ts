import { encodeAbiParameters, encodePacked, hexToBigInt, keccak256, toBytes, type Hex } from 'viem';
import {
  compileGraphGame,
  encodePlainGameData,
  ladderOptionPassesCap,
  ladderPayout,
  walkLadder,
  type LadderNode,
  type LadderWalk,
} from '@chain-protocol/casino-sdk/graph-engine';
import fairground, {
  ACTION_BANK,
  ACTION_RIDE,
  LABEL,
  PRIZE_DENOMINATOR,
  RATIO_DENOMINATOR,
  configurationOf,
  entryPrizes,
  type EntryPrizes,
} from '../title';

// ─────────────────────────────────────────────────────────────────────────────
// FAIRGROUND — the booth's side of the graph-engine title (src/title.ts).
//
// The engine settles every session from the compiled graph and the VRF words.
// Nothing here decides an outcome or a payout: it opens sessions, replays the
// words with the SDK's own walk, and draws the wheel from what the walk says.
// ─────────────────────────────────────────────────────────────────────────────

export const WAD = 1_000_000_000_000_000_000n;
export const MAX_SEGMENTS = 16;
export const MIN_SEGMENTS = 8;
/** The 9-byte paint layout carried in the game data's tail (and in ?wheel= links). */
export const PAINT_BYTES = 9;
/** Plain game data: tag 0x00 ‖ uint16 configuration ‖ tail. */
const PLAIN_HEADER_BYTES = 3;

/** The compiled title, built once in the browser (about 30 ms for 300 ladders). */
export const compiled = compileGraphGame(fairground);
export const graph = compiled.graph;

export type Tier = 0 | 1 | 2; // 0 safe, 1 mid, 2 risky
export type ToyRarity = 'common' | 'rare' | 'legendary';

export type Paint = {
  segmentCount: number;
  tiers: Tier[];
};

export type Prize = {
  id: number; // 0..5: which carnival toy
  rarity: ToyRarity;
};

// ── paint layout (display only: the engine reads the configuration, not this) ─
// byte 0: segmentCount (8..16)
// bytes 1..8: segments 0..15, two 4-bit tiers per byte,
//             low nibble = segment 2i, high nibble = segment 2i+1
export function encodePaint(paint: Paint): Hex {
  const bytes = new Uint8Array(PAINT_BYTES);
  bytes[0] = paint.segmentCount & 0xff;
  for (let i = 0; i < paint.segmentCount; i += 2) {
    bytes[1 + (i >> 1)] = (paint.tiers[i] & 0x0f) | ((paint.tiers[i + 1] & 0x0f) << 4);
  }
  return toHex(bytes);
}

export function decodePaint(data: Hex): Paint | null {
  try {
    const bytes = toBytes(data);
    if (bytes.length !== PAINT_BYTES) return null;
    const segmentCount = bytes[0];
    if (!isValidSegmentCount(segmentCount)) return null;
    const tiers: Tier[] = new Array(segmentCount);
    for (let i = 0; i < segmentCount; i += 2) {
      const b = bytes[1 + (i >> 1)];
      tiers[i] = (b & 0x0f) as Tier;
      tiers[i + 1] = ((b >> 4) & 0x0f) as Tier;
    }
    const paint = { segmentCount, tiers };
    return isLegalPaint(paint) ? paint : null;
  } catch {
    return null;
  }
}

// ── legality: a paint is legal exactly when its composition is a configuration ─

export function isValidSegmentCount(n: number): boolean {
  return n % 2 === 0 && n >= MIN_SEGMENTS && n <= MAX_SEGMENTS;
}

export function tierCounts(paint: Paint): [number, number, number] {
  const counts: [number, number, number] = [0, 0, 0];
  for (const t of paint.tiers) counts[t]++;
  return counts;
}

/** The title's configuration for this paint, or -1 when the paint is not legal. */
export function configurationFor(paint: Paint): number {
  if (!isValidSegmentCount(paint.segmentCount) || paint.tiers.length !== paint.segmentCount) return -1;
  if (paint.tiers.some(t => t < 0 || t > 2)) return -1;
  const [cSafe, cMid, cRisky] = tierCounts(paint);
  return configurationOf({ n: paint.segmentCount, cSafe, cMid, cRisky });
}

/**
 * Legal: at least one risky slice, at least one safe or mid slice, and risky on at
 * most half the wheel. Every such composition is one of the title's 300 roots.
 */
export function isLegalPaint(paint: Paint): boolean {
  return configurationFor(paint) >= 0;
}

/** The floored prizes the engine pays per tier, in prize units (1e6 = 1x). */
export function wheelPrizes(paint: Paint): EntryPrizes {
  const [cSafe, cMid, cRisky] = tierCounts(paint);
  return entryPrizes({ n: paint.segmentCount, cSafe, cMid, cRisky });
}

export function prizeOfTier(prizes: EntryPrizes, tier: Tier): bigint {
  return tier === 0 ? prizes.safe : tier === 1 ? prizes.mid : prizes.risky;
}

/**
 * What the floored prizes return per unit wagered, in WAD. A hair under 0.96 for most
 * paints (95.9999% at worst); the engine itself reports 96.00%, see docs/MATH.md.
 */
export function flooredRtpWad(paint: Paint): bigint {
  const [cSafe, cMid, cRisky] = tierCounts(paint);
  const p = wheelPrizes(paint);
  const total = p.safe * BigInt(cSafe) + p.mid * BigInt(cMid) + p.risky * BigInt(cRisky);
  return (total * WAD) / (PRIZE_DENOMINATOR * BigInt(paint.segmentCount));
}

// ── sessions ─────────────────────────────────────────────────────────────────

/** Opens the paint's configuration; the paint rides along in the tail for display. */
export function gameDataFor(paint: Paint): Hex {
  return encodePlainGameData(configurationFor(paint), encodePaint(paint));
}

/** The paint a session was opened with, read back from its game data's tail. */
export function paintFromGameData(gameData: Hex): Paint | null {
  try {
    const bytes = toBytes(gameData);
    if (bytes.length !== PLAIN_HEADER_BYTES + PAINT_BYTES || bytes[0] !== 0) return null;
    const configuration = (bytes[1] << 8) | bytes[2];
    const paint = decodePaint(toHex(bytes.slice(PLAIN_HEADER_BYTES)));
    // the tail is display-only, so only trust it when it is the configuration played
    return paint && configurationFor(paint) === configuration ? paint : null;
  } catch {
    return null;
  }
}

/** actionData at the rung: abi.encode(uint256 index). RIDE is option 0, BANK the option count. */
export const RIDE_ACTION: Hex = encodeAbiParameters([{ type: 'uint256' }], [BigInt(ACTION_RIDE)]);
export const BANK_ACTION: Hex = encodeAbiParameters([{ type: 'uint256' }], [BigInt(ACTION_BANK)]);

export function ladderFor(paint: Paint): LadderNode {
  return graph.nodes[graph.roots[configurationFor(paint)]] as LadderNode;
}

/** A session's state, rebuilt from its words exactly as the engine walked them. */
export type RoundView = {
  /** The tier the wheel drew, from the entry label. */
  tier: Tier;
  /** Which slice of that tier the wheel shows. Cosmetic, from the entry word. */
  segment: number;
  /** The cosmetic prize drop, from the entry word. */
  prize: Prize;
  /** The tier's floored prize, in prize units. */
  entryPrize: bigint;
  /** Rides won so far. */
  ridesWon: number;
  /** The last ride's result, when there was one. */
  lastRide: 'won' | 'lost' | null;
  /** The banked multiplier, WAD, as the engine holds it (0 after a lost ride). */
  multiplierWad: bigint;
  /**
   * The hold as a multiple of the wager in prize units: the floored prize doubled once per
   * ride won, 0 after a lost ride. This is the multiplier the booth shows. The engine's WAD
   * hold can sit a hair under it, so a payout may be one base unit below (docs/MATH.md §4).
   */
  holdUnits: bigint;
  /** What BANK pays right now, in token base units. */
  cashOut: bigint;
  /** How many more rides the 100x cap allows. */
  ridesLeft: number;
  status: 'waiting' | 'settled';
  /** Set when settled: what the engine paid. */
  payout?: bigint;
};

/**
 * Replays a session: `words[0]` drew the wheel, every later word resolved one ride.
 * `banked` adds the cash-out the player took last. walkLadder throws where the engine
 * reverts, so a replay that returns is one the chain could have played.
 */
export function replayRound(paint: Paint, wager: bigint, words: readonly Hex[], banked = false): RoundView {
  const configuration = configurationFor(paint);
  const root = graph.roots[configuration];
  const ladder = graph.nodes[root] as LadderNode;
  const rides = words.slice(1).map(randomness => ({ option: ACTION_RIDE, randomness }));
  let walk: LadderWalk = walkLadder(graph, root, words[0], rides, wager);
  if (banked && walk.status === 'waiting') walk = walkLadder(graph, root, words[0], [...rides, 'cashOut'], wager);

  const [tierLabel, ...rideLabels] = walk.labels;
  const tier = (tierLabel === LABEL.safe ? 0 : tierLabel === LABEL.mid ? 1 : 2) as Tier;
  const last = rideLabels[rideLabels.length - 1];
  const entryPrize = prizeOfTier(wheelPrizes(paint), tier);
  const ridesWon = rideLabels.filter(label => label === LABEL.win).length;
  return {
    tier,
    segment: sliceFor(paint, tier, words[0]),
    prize: prizeFor(words[0]),
    entryPrize,
    ridesWon,
    lastRide: last === undefined ? null : last === LABEL.win ? 'won' : 'lost',
    multiplierWad: walk.multiplierWad,
    holdUnits: walk.multiplierWad === 0n ? 0n : entryPrize << BigInt(ridesWon),
    cashOut: ladderPayout(ladder, PRIZE_DENOMINATOR, walk.multiplierWad, wager),
    ridesLeft: walk.multiplierWad === 0n ? 0 : ridesLeftAt(ladder, walk.multiplierWad),
    status: walk.status,
    payout: walk.status === 'settled' ? walk.payout : undefined,
  };
}

/** Rides the engine still allows from this multiplier before a win would reach the cap. */
export function ridesLeftAt(ladder: LadderNode, multiplierWad: bigint): number {
  const ride = ladder.rungs[0].options[ACTION_RIDE];
  let rides = 0;
  // a win scales by 2·RATIO_DENOMINATOR / RATIO_DENOMINATOR: an exact doubling
  for (let m = multiplierWad; !ladderOptionPassesCap(ladder, ride, m); m *= 2n) rides++;
  return rides;
}

/** Rides a fresh landing on this prize allows. */
export function ridesFromPrize(paint: Paint, prize: bigint): number {
  return ridesLeftAt(ladderFor(paint), (WAD * prize) / RATIO_DENOMINATOR);
}

// ── cosmetic draws from the entry word ───────────────────────────────────────
// The engine draws the TIER (keccak(word, "graph", 0)). Which slice of that tier the
// pointer stops on, and the prize toy, come from the same word under their own
// domains: deterministic, verifiable, and unable to move a payout.

function domainDraw(word: Hex, domain: string): bigint {
  return hexToBigInt(keccak256(encodePacked(['bytes32', 'string'], [word, domain])));
}

export function sliceFor(paint: Paint, tier: Tier, word: Hex): number {
  const slices = paint.tiers.flatMap((t, i) => (t === tier ? [i] : []));
  return slices[Number(domainDraw(word, 'fairground:slice') % BigInt(slices.length))];
}

export function prizeFor(word: Hex): Prize {
  const draw = domainDraw(word, 'fairground:prize');
  const roll = Number(draw & 0xffn);
  return { id: Number((draw >> 8n) % 6n), rarity: rarityOf(roll) };
}

export function rarityOf(b: number): ToyRarity {
  if (b < 196) return 'common';
  if (b < 246) return 'rare';
  return 'legendary';
}

/** A demo word: 32 bytes from the browser's CSPRNG. */
export function demoWord(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

// ── presets ──────────────────────────────────────────────────────────────────

export function defaultPaint(): Paint {
  return {
    segmentCount: 12,
    tiers: [2, 0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1] as Tier[],
  };
}

/**
 * Ready-made paints, so a newcomer can play well without learning a rule and
 * can see the whole risk range in one tap. Every preset is legal by
 * construction: at least one risky slice, at least one cushion, and risky
 * never above half the wheel. Risky and mid slices are spread evenly around
 * the wheel rather than clumped, which is what makes the spread legible.
 */
export type PaintPresetId = 'gentle' | 'standard' | 'wild';

export const PAINT_PRESETS: { id: PaintPresetId; label: string; hint: string }[] = [
  { id: 'gentle', label: 'Gentle', hint: 'one risky slice: a steady grind' },
  { id: 'standard', label: 'Standard', hint: 'a quarter of the wheel at risky' },
  { id: 'wild', label: 'Wild', hint: 'half the wheel at risky: the biggest multiples' },
];

export function presetPaint(segmentCount: number, id: PaintPresetId): Paint {
  const quarter = Math.round(segmentCount / 4);
  const risky = id === 'gentle' ? 1 : id === 'wild' ? Math.floor(segmentCount / 2) : quarter;
  const mid = id === 'gentle' ? Math.max(1, Math.round(segmentCount / 6)) : quarter;

  const tiers = new Array<Tier>(segmentCount).fill(0);
  const place = (tier: Tier, count: number) => {
    for (let k = 0; k < count; k += 1) {
      let idx = Math.floor((k * segmentCount) / count) % segmentCount;
      while (tiers[idx] !== 0) idx = (idx + 1) % segmentCount;
      tiers[idx] = tier;
    }
  };
  place(2, risky);
  place(1, mid);

  const paint: Paint = { segmentCount, tiers };
  // guards the helper itself: a future edit here can never hand the game an
  // illegal paint, which has no configuration on-chain
  return isLegalPaint(paint) ? paint : defaultPaint();
}

/** Which preset, if any, matches this paint exactly. */
export function presetOf(paint: Paint): PaintPresetId | null {
  for (const p of PAINT_PRESETS) {
    const candidate = presetPaint(paint.segmentCount, p.id);
    if (candidate.tiers.every((t, i) => t === paint.tiers[i])) return p.id;
  }
  return null;
}

// ── formatting ───────────────────────────────────────────────────────────────

/** Prize units (1e6 = 1x) as a multiplier with 2 decimals, floored: 12.36×. */
export function formatPrize(units: bigint): string {
  const whole = units / PRIZE_DENOMINATOR;
  const frac = ((units % PRIZE_DENOMINATOR) * 100n) / PRIZE_DENOMINATOR;
  return `${whole}.${frac.toString().padStart(2, '0')}×`;
}

/** Prize units to `dp` decimals, no multiplier sign: for the proof strip. */
export function formatUnitsPlain(units: bigint, dp = 3): string {
  const scale = 10n ** BigInt(dp);
  const whole = units / PRIZE_DENOMINATOR;
  const frac = ((units % PRIZE_DENOMINATOR) * scale) / PRIZE_DENOMINATOR;
  return `${whole}.${frac.toString().padStart(dp, '0')}`;
}

/** WAD as a percentage to `dp` decimals, floored: 95.9999. */
export function formatPercent(wad: bigint, dp = 4): string {
  const scaled = (wad * 100n * 10n ** BigInt(dp)) / WAD;
  const scale = 10n ** BigInt(dp);
  return `${scaled / scale}.${(scaled % scale).toString().padStart(dp, '0')}`;
}

export function toHex(bytes: Uint8Array): Hex {
  let out = '0x';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out as Hex;
}
