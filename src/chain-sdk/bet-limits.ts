import type { HostSnapshotV1 } from './types';

const BASIS_POINTS = 10_000n;

const toBigIntOrUndefined = (value: string | undefined): bigint | undefined => {
  if (value === undefined) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
};

/**
 * The highest wager `openSession` accepts right now, in token base units, for
 * a game whose worst-case payout is `wager * maxMultiplierX` — the shape of
 * every linear `quoteCaps` implementation. Mirrors the casino facet's checks:
 * the round's reserved profit (`wager * (maxMultiplierX - 1)`) must fit in
 * `casino.maxAllowedReservedProfit`, and the wager itself must stay under
 * `casino.maxBetAmount` when the platform has configured one.
 *
 * Returns `undefined` when the host publishes no applicable limit (older
 * hosts, or a ≤1x multiplier with no wager ceiling) — fall back to your own
 * limits instead of treating it as unlimited. Games whose reserved profit is
 * not linear in the wager should invert their own `quoteCaps` against
 * `casino.maxAllowedReservedProfit` directly.
 */
export const computeMaxWager = (
  snapshot: Pick<HostSnapshotV1, 'casino'> | null | undefined,
  input: { maxMultiplierX: number },
): bigint | undefined => {
  const casino = snapshot?.casino;
  if (!casino) return undefined;

  const maxBetAmount = toBigIntOrUndefined(casino.maxBetAmount);
  const wagerCeiling = maxBetAmount && maxBetAmount > 0n ? maxBetAmount : undefined;

  if (!Number.isFinite(input.maxMultiplierX)) return wagerCeiling;
  // Ceil to a basis point: a coarser multiplier may only shrink the result,
  // so the returned wager is never one the facet would still reject.
  const multiplierBps = BigInt(Math.ceil(input.maxMultiplierX * Number(BASIS_POINTS)));
  const reservedProfitBps = multiplierBps - BASIS_POINTS;

  const maxAllowedReservedProfit = toBigIntOrUndefined(casino.maxAllowedReservedProfit);
  // A ≤1x multiplier reserves no profit, so the risk leg never binds.
  if (reservedProfitBps <= 0n || maxAllowedReservedProfit === undefined) {
    return wagerCeiling;
  }

  const riskBoundWager = (maxAllowedReservedProfit * BASIS_POINTS) / reservedProfitBps;
  if (wagerCeiling === undefined) return riskBoundWager;
  return riskBoundWager < wagerCeiling ? riskBoundWager : wagerCeiling;
};
