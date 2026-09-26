import { decodeAbiParameters, encodeAbiParameters, keccak256, toBytes } from 'viem';
import type { HexString } from '../chain-sdk/types';

// ─────────────────────────────────────────────────────────────────────────────
// FAIRGROUND — shared game math.
//
// The contract (contract/FairgroundWheel.sol) is authoritative; every function
// here mirrors its integer math exactly so previews equal on-chain reality.
// ─────────────────────────────────────────────────────────────────────────────

export const WAD = 1_000_000_000_000_000_000n;
/** 96% return-to-player, in WAD. Eligibility window is 93–98%. */
export const RTP_WAD = 960_000_000_000_000_000n;
/** SAFE anchor payout: a fifth of your stake back on every safe segment. */
export const SAFE_ANCHOR_WAD = WAD / 5n; // 0.2e18
/** Tier weights: MID = 2λ, RISKY = 6λ — PLAIN weights (not WAD-scaled). */
export const MID_WEIGHT = 2n;
export const RISKY_WEIGHT = 6n;
export const MAX_SEGMENTS = 16;
export const MIN_SEGMENTS = 8;
export const MAX_MULTIPLIER_WAD = 16n * WAD; // contract hard cap on one tier (real max ≈ 12.36×)
/** A winning ride doubles the landed multiplier, on an exactly fair coin flip. */
export const RIDE_FACTOR = 2n;
/** The ride coin wins on half the byte range — exactly 1/2, no bias, no rejection. */
export const RIDE_WIN_LIMIT = 128;
/** Worst-case payout multiplier of a whole round (the ride doubling the top tier).
 *  Heaviest legal paint pays 12.36×, so a ridden round tops out at ≈ 24.72×. */
export const MAX_ROUND_MULTIPLIER_X = 24.73;
export const GAME_DATA_SIZE = 9; // 1 count byte + 8 paint bytes (2 segments per byte)
export const GAME_STATE_SIZE = 96; // abi.encode(uint8 segmentCount, uint8 segment, uint8 stage)

/** Round stages, mirrored from contract/FairgroundWheel.sol. */
export const STAGE_SPIN = 0; // no segment yet — waiting for the spin word
/** Awaiting a player action: the player may bank or ride. */
export const STAGE_DECIDE = 1;
export const STAGE_RIDE = 2; // a ride is in flight — waiting for the coin word
export const STAGE_BANKED = 3;
export const SEGMENT_UNKNOWN = 0xff;

export const ACTION_BANK = 0;
export const ACTION_RIDE = 1;

export type Tier = 0 | 1 | 2; // 0 safe, 1 mid, 2 risky
export type ToyRarity = 'common' | 'rare' | 'legendary';

export type Paint = {
  segmentCount: number;
  tiers: Tier[];
};

export type PriceList = {
  safe: bigint;
  mid: bigint;
  risky: bigint;
};

export type WheelOutcome = {
  segment: number;
  tier: Tier;
  payout: bigint;
  multiplierWad: bigint;
  prize: Prize;
};

export type Prize = {
  id: number; // 0..5 — which carnival toy
  rarity: ToyRarity;
  roll: number; // 0..255 byte used for the roll
};

// ── gameData packing ─────────────────────────────────────────────────────────
// byte 0: segmentCount | tierOf(segment 1) << 4
// ── gameData packing (9 bytes) ─────────────────────────────────────────────
// byte 0: segmentCount (8..16)
// bytes 1..8: segments 0..15, two 4-bit tiers per byte —
//             low nibble = segment 2i, high nibble = segment 2i+1
export function encodeGameData(paint: Paint): HexString {
  const bytes = new Uint8Array(GAME_DATA_SIZE);
  bytes[0] = paint.segmentCount & 0xff;
  for (let i = 0; i < paint.segmentCount; i += 2) {
    bytes[1 + (i >> 1)] = (paint.tiers[i] & 0x0f) | ((paint.tiers[i + 1] & 0x0f) << 4);
  }
  return toHex(bytes);
}

export function decodeGameData(gameData: HexString): Paint | null {
  try {
    const bytes = toBytes(gameData);
    if (bytes.length !== GAME_DATA_SIZE) return null;
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

// ── paint validation (mirrors contract) ──────────────────────────────────────

export function isValidSegmentCount(n: number): boolean {
  return n % 2 === 0 && n >= MIN_SEGMENTS && n <= MAX_SEGMENTS;
}

/**
 * Legal paint (mirrors the contract exactly):
 *   - segment count even, 8..16
 *   - every tier value is 0..2
 *   - at least one risky segment (cR ≥ 1)
 *   - at least one cushion segment (cS + cM ≥ 1)
 *   - risky covers at most half the wheel (2·cR ≤ N)
 *
 * Within this space the anchor-derived scale λ = (RTP·N − 0.2·cS)/(2·cM + 6·cR)
 * is provably ≥ 0.24·WAD, so ordering always holds: 0.2 < 2λ < 6λ —
 * safe < mid < risky on every legal paint, no edge cases, and the heaviest
 * legal multiplier is ≈ 12.36× (N=16, one risky segment) — light-tail for the
 * vault (max payout < 100× wager, risky win-prob ≥ 1/16 ≥ 0.1%).
 */
export function isLegalPaint(paint: Paint): boolean {
  if (!isValidSegmentCount(paint.segmentCount)) return false;
  if (paint.tiers.length !== paint.segmentCount) return false;
  for (const t of paint.tiers) if (t < 0 || t > 2) return false;
  const counts = tierCounts(paint);
  const hasRisky = counts[2] >= 1n;
  const hasCushion = counts[0] + counts[1] >= 1n;
  const riskyAtMostHalf = counts[2] * 2n <= BigInt(paint.segmentCount);
  return hasRisky && hasCushion && riskyAtMostHalf;
}

export function tierCounts(paint: Paint): [bigint, bigint, bigint] {
  const counts: [bigint, bigint, bigint] = [0n, 0n, 0n];
  for (const t of paint.tiers) counts[t]++;
  return counts;
}

// ── pricing: anchor + derived scale (RTP exactly RTP_WAD for any legal paint) ─
//   RTP · N = SAFE·cSafe + MID·cMid + RISKY·cRisky
//   SAFE = 0.2 (anchor), MID = 2·λ, RISKY = 6·λ
//   → λ = (RTP·N − 0.2·cSafe) / (2·cMid + 6·cRisky)
// λ is floored in WAD; the floor remainder (a few thousandths of a cent per
// spin) goes to the house, so realized RTP stays inside 93–98% by construction
// and verifies at ≈ 96.000%. Verify-parity asserts contract == client bit-for-bit.
export function priceWheel(paint: Paint): PriceList {
  const n = BigInt(paint.segmentCount);
  const [cSafe, cMid, cRisky] = tierCounts(paint);
  const numerator = RTP_WAD * n - SAFE_ANCHOR_WAD * cSafe;
  const denominator = MID_WEIGHT * cMid + RISKY_WEIGHT * cRisky; // plain weights
  const lambda = numerator / denominator; // floor, in WAD
  return {
    safe: SAFE_ANCHOR_WAD,
    mid: MID_WEIGHT * lambda,
    risky: RISKY_WEIGHT * lambda,
  };
}

export function expectedPayoutWad(wager: bigint, paint: Paint): bigint {
  const n = BigInt(paint.segmentCount);
  const [cSafe, cMid, cRisky] = tierCounts(paint);
  const p = priceWheel(paint);
  return (wager * (p.safe * cSafe + p.mid * cMid + p.risky * cRisky)) / (n * WAD);
}

// ── risk quoting (mirrors contract quoteRiskParams) ──────────────────────────

/** Worst-case payout of a whole round: the ride doubling the heaviest tier. */
export function maxPayoutFor(wager: bigint, paint: Paint): bigint {
  return RIDE_FACTOR * ((wager * priceWheel(paint).risky) / WAD);
}

export function maxReservedProfitFor(wager: bigint, paint: Paint): bigint {
  const payout = maxPayoutFor(wager, paint);
  return payout > wager ? payout - wager : 0n;
}

/** Probability of the top payout — the heaviest tier AND a winning coin: cRisky/N · 1/2. */
export function probabilityWadFor(paint: Paint): bigint {
  const n = BigInt(paint.segmentCount);
  return (tierCounts(paint)[2] * WAD) / (RIDE_FACTOR * n);
}

/** The banked payout for a landed segment — the value the player holds when deciding. */
export function bankedPayout(wager: bigint, paint: Paint, segment: number): bigint {
  const tier = paint.tiers[segment];
  const prices = priceWheel(paint);
  const multiplier = tier === 0 ? prices.safe : tier === 1 ? prices.mid : prices.risky;
  return (wager * multiplier) / WAD;
}

/** The ride's payout: the banked amount doubled, or nothing at all. */
export function ridePayout(banked: bigint, won: boolean): bigint {
  return won ? RIDE_FACTOR * banked : 0n;
}

/** The ride coin: byte 0 of the ride word, fair by construction. */
export function rideCoinWon(randomness: HexString): boolean {
  return toBytes(randomness)[0] < RIDE_WIN_LIMIT;
}

// ── gameState (contract mirror) ──────────────────────────────────────────────
// abi.encode(uint8 segmentCount, uint8 segment, uint8 stage); `segment` is
// 0xff until the spin word lands.

export function encodeGameState(segmentCount: number, segment: number, stage: number): HexString {
  return encodeAbiParameters(
    [{ type: 'uint8' }, { type: 'uint8' }, { type: 'uint8' }],
    [segmentCount, segment, stage],
  );
}

export function decodeGameState(gameState: HexString): { segment: number; stage: number } | null {
  try {
    if (toBytes(gameState).length !== GAME_STATE_SIZE) return null;
    const [, segment, stage] = decodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint8' }, { type: 'uint8' }],
      gameState,
    );
    return { segment: Number(segment), stage: Number(stage) };
  } catch {
    return null;
  }
}

/**
 * Body variance — mirrors `_bodyVarianceScaled` in the contract exactly.
 *
 * `ICasinoGameV2` defines `bodyVarianceScaled` as the variance of this bet's
 * payout with the TOP tier removed, per bet, in wei²·1e18, and a game with a
 * single winning tier returns 0.
 *
 * The risky tier is the top tier, so the removal leaves only SAFE and MID:
 *   - the doubled mid still pays at most the stake (2λ ≤ 1): no winning tier
 *     survives the removal → exactly 0;
 *   - otherwise MID is a second winning tier. Taken under the worst-case policy
 *     (the player rides), the surviving payout is the doubled mid multiplier
 *     behind two independent, unbiased flips — B that MID is landed and K that
 *     the fair ride wins. With E[K]=1, E[K²]=RIDE_FACTOR²/2=2 and p = cMid/N:
 *       Var = X²·p·(2 − p) = cMid·(2N − cMid)·X² / N²
 *     Dropping the ride's coin (K ≡ 1) recovers the bank-only p(1−p)·X².
 */
export function bodyVarianceScaledFor(wager: bigint, paint: Paint): bigint {
  const n = BigInt(paint.segmentCount);
  const cMid = tierCounts(paint)[1];
  if (cMid === 0n) return 0n; // nothing between safe and risky
  const { mid } = priceWheel(paint);
  // the doubled mid must beat the stake to be a winning outcome at all
  if (mid <= WAD / RIDE_FACTOR) return 0n;
  const payout = (wager * mid) / WAD;
  return (((payout * payout) * cMid * (2n * n - cMid)) / (n * n)) * WAD;
}

// ── outcome: rejection-sampled uniform segment + prize roll ───────────────────
// Mirrors _segmentFromRandomness: for N segments, limit = floor(256/N)·N;
// accept the first byte < limit, segment = b % N (exactly uniform).
// Prize: the first byte AFTER the segment byte (any value) — id = b % 6,
// rarity by value (b < 196 common, < 246 rare, else legendary). If the
// segment byte was the last byte, the prize byte falls back to that byte.
export function outcomeFromRandomness(wager: bigint, paint: Paint, randomness: HexString): WheelOutcome {
  const bytes = toBytes(randomness);
  const { segment, segIndex } = segmentFromBytes(bytes, paint.segmentCount);
  const prizeByte = prizeByteFromBytes(bytes, segIndex);
  const tier = paint.tiers[segment];
  const prices = priceWheel(paint);
  const multiplierWad = tier === 0 ? prices.safe : tier === 1 ? prices.mid : prices.risky;
  return {
    segment,
    tier,
    multiplierWad,
    payout: (wager * multiplierWad) / WAD,
    prize: { id: prizeByte % 6, rarity: rarityOf(prizeByte), roll: prizeByte },
  };
}

export function segmentLimit(segmentCount: number): number {
  return Math.floor(256 / segmentCount) * segmentCount;
}

export function segmentFromBytes(bytes: Uint8Array, segmentCount: number): { segment: number; segIndex: number } {
  const limit = segmentLimit(segmentCount);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < limit) return { segment: b % segmentCount, segIndex: i };
  }
  // statistically unreachable (p < 2^-500); mirrors the contract's fallback:
  // full word modulo N
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  return { segment: Number(acc % BigInt(segmentCount)), segIndex: bytes.length - 1 };
}

export function prizeByteFromBytes(bytes: Uint8Array, segIndex: number): number {
  return segIndex + 1 < bytes.length ? bytes[segIndex + 1] : bytes[segIndex];
}

export function rarityOf(b: number): ToyRarity {
  if (b < 196) return 'common';
  if (b < 246) return 'rare';
  return 'legendary';
}

// ── helpers ──────────────────────────────────────────────────────────────────

export function toHex(bytes: Uint8Array): HexString {
  let out = '0x';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out as HexString;
}

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
  // illegal paint, which would be rejected by the contract on-chain
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

/** Demo-mode PRNG: xorshift32 seeded from Date.now(), expanded to bytes32. */
export function demoRandomness(seed: number): HexString {
  let x = seed | 0 || 1;
  const next = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x >>> 0;
  };
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = next() & 0xff;
  return toHex(bytes);
}

export function demoSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) | 0 || 12345;
}

export function formatMultiplier(wad: bigint): string {
  const whole = wad / WAD;
  const frac = ((wad % WAD) * 100n) / WAD;
  return `${whole}.${frac.toString().padStart(2, '0')}×`;
}

/** Plain WAD value to `dp` decimals, no multiplier sign — for the proof strip,
 *  where the reader needs the numbers the equation is actually made of. */
export function formatWad(wad: bigint, dp = 3): string {
  const scale = 10n ** BigInt(dp);
  const whole = wad / WAD;
  const frac = ((wad % WAD) * scale) / WAD;
  return `${whole}.${frac.toString().padStart(dp, '0')}`;
}

/** WAD → percent to 2 decimals, ROUNDED. Every legal paint floors λ, so the
 *  per-slice multipliers sum a few wei short of the exact target; truncating
 *  here would print 95.99% and make the one number the whole game is about look
 *  wrong. Rounded, it reads 96.00% — which is the true value to 2dp. */
export function formatPercent(wad: bigint): string {
  const scaled = (wad * 10_000n + WAD / 2n) / WAD; // 2dp of (wad × 100)
  return `${scaled / 100n}.${(scaled % 100n).toString().padStart(2, '0')}`;
}

export function keccakOf(bytes: Uint8Array): HexString {
  return keccak256(bytes);
}

export function encodeSingle(type: 'uint256', value: bigint): HexString {
  return encodeAbiParameters([{ type }], [value]);
}

export function decodeSingle(type: 'uint256', data: HexString): bigint {
  const [v] = decodeAbiParameters([{ type }], data);
  return v;
}
