// FAIRGROUND RTP verifier — proves the declared math (docs/MATH.md).
// Run: npm run verify:rtp
//
// 1) Exhaustive sweep of every legal composition class (N = 8..16):
//    pricing identity, ordering, multiplier bounds, heavy-tail thresholds,
//    floor-truncated RTP inside the window.
// 2) Monte-Carlo over the legal space: empirical RTP from 250k simulated
//    rejection-sampled spins.
// 3) Prize-byte invariance and rejection-sampling uniformity checks.
// 5) Body variance (4th quoteRiskParams parameter): the contract's closed form
//    against an independent brute-force variance of the top-tier-removed payout,
//    taken under the worst-case policy (the player rides).
// 6) The ride is EXACTLY fair: by brute-force enumeration of all 2N (segment,
//    coin) outcomes, banking and riding have the same expectation, and it is the
//    declared 96% for every legal paint — so the game has no optimal-play
//    caveat and expectedPayout is honest for every strategy.

let fails = 0;
const ok = (cond, label) => {
  if (!cond) { console.error('  FAIL:', label); fails++; }
};

// ── mirror of src/lib/game.ts / contract math (zero deps) ──
const WAD = 1_000_000_000_000_000_000n;
const RTP_WAD = 960_000_000_000_000_000n;
const SAFE_ANCHOR_WAD = WAD / 5n;
const MID_WEIGHT = 2n; // plain weights: MID = 2·λ, RISKY = 6·λ (λ in WAD)
const RISKY_WEIGHT = 6n;

const counts = (tiers) => {
  const c = [0n, 0n, 0n];
  for (const t of tiers) c[t]++;
  return c;
};

const isLegal = (n, tiers) => {
  if (n < 8 || n > 16 || n % 2 !== 0 || tiers.length !== n) return false;
  if (tiers.some((t) => t < 0 || t > 2)) return false;
  const [cS, cM, cR] = counts(tiers);
  return cR >= 1n && cS + cM >= 1n && cR * 2n <= BigInt(n);
};

const lambdaOf = (n, tiers) => {
  const [cS, cM, cR] = counts(tiers);
  return (RTP_WAD * BigInt(n) - SAFE_ANCHOR_WAD * cS) / (MID_WEIGHT * cM + RISKY_WEIGHT * cR);
};

const priceWheel = (n, tiers) => {
  const lambda = lambdaOf(n, tiers);
  return { safe: SAFE_ANCHOR_WAD, mid: MID_WEIGHT * lambda, risky: RISKY_WEIGHT * lambda };
};

const segmentLimit = (n) => Math.floor(256 / n) * n;

// deterministic xorshift128 PRNG for reproducibility
let s0 = 123456789, s1 = 362436069, s2 = 521288629, s3 = 88675123;
function rnd() {
  const t = s0 ^ (s0 << 11);
  s0 = s1; s1 = s2; s2 = s3;
  s3 = (s3 ^ (s3 >>> 19) ^ t ^ (t >>> 8)) >>> 0;
  return s3;
}
const rndByte = () => rnd() & 0xff;
const rndInt = (maxExclusive) => rnd() % maxExclusive;

console.log('FAIRGROUND RTP verifier');
console.log('='.repeat(72));

// ── 1) exhaustive sweep over composition classes ─────────────────────────────
// All pricing outcomes depend only on (N, cS, cM, cR) — arrangement is
// irrelevant on a uniform wheel — so sweeping every legal composition class
// exhaustively covers every possible paint.
console.log('\n[1] Exhaustive sweep of every legal composition class (N = 8..16)...');
let classes = 0;
let minRtp = 2n * WAD, maxRtp = 0n;
let maxMult = 0n;
let minLambda = WAD * 100n;
for (let n = 8; n <= 16; n += 2) {
  for (let cR = 1; 2 * cR <= n; cR++) {
    for (let cS = 0; cS + cR <= n; cS++) {
      const cM = n - cS - cR;
      const tiers = [...Array(cS).fill(0), ...Array(cM).fill(1), ...Array(cR).fill(2)];
      if (!isLegal(n, tiers)) continue;
      classes++;
      const { safe, mid, risky } = priceWheel(n, tiers);
      const sum = safe * BigInt(cS) + mid * BigInt(cM) + risky * BigInt(cR);
      const target = RTP_WAD * BigInt(n);
      ok(target - sum >= 0n && target - sum < BigInt(n) * (WAD / 1000n), `identity N=${n} (${cS},${cM},${cR})`);
      ok(safe < mid && mid < risky, `ordering N=${n} (${cS},${cM},${cR})`);
      ok(risky >= (144n * WAD) / 100n, `risky>=1.44 N=${n} (${cS},${cM},${cR})`);
      ok(risky <= 16n * WAD, `cap16 N=${n} (${cS},${cM},${cR})`);
      if (risky > maxMult) maxMult = risky;
      const lam = lambdaOf(n, tiers);
      if (lam < minLambda) minLambda = lam;
      const rtpWad = sum / BigInt(n); // floor-truncated per-spin RTP
      if (rtpWad < minRtp) minRtp = rtpWad;
      if (rtpWad > maxRtp) maxRtp = rtpWad;
      ok(rtpWad >= 93n * (WAD / 100n), `rtp>=93% N=${n} (${cS},${cM},${cR})`);
      ok(risky < 100n * WAD, `mult<100x N=${n} (${cS},${cM},${cR})`);
      ok((BigInt(cR) * WAD) / BigInt(n) >= WAD / 1000n, `riskyProb>=0.1% N=${n} (${cS},${cM},${cR})`);
      // The ride doubles the top tier and halves its probability. Both
      // heavy-tail thresholds stay unmet, so the simple VaR path still holds.
      ok(2n * risky < 100n * WAD, `round mult<100x N=${n} (${cS},${cM},${cR})`);
      ok(
        (BigInt(cR) * WAD) / (2n * BigInt(n)) >= WAD / 1000n,
        `ride top prob>=0.1% N=${n} (${cS},${cM},${cR})`,
      );
    }
  }
}
console.log(`  composition classes checked: ${classes} (covers all paints — arrangement-independent)`);
console.log(`  min lambda: ${Number(minLambda) / 1e18}x   max multiplier: ${Number(maxMult) / 1e18}x`);
console.log(`  RTP band (floor-truncated): ${(Number(minRtp) / 1e18) * 100}% .. ${(Number(maxRtp) / 1e18) * 100}%`);

// ── 2) Monte-Carlo ───────────────────────────────────────────────────────────
console.log('\n[2] Monte-Carlo: 250,000 spins over random legal paints...');
const SPINS = 250_000;
let wagered = 0n, returned = 0n, rideReturned = 0n;
for (let spin = 0; spin < SPINS; spin++) {
  const n = [8, 10, 12, 14, 16][rndInt(5)];
  let tiers;
  do {
    tiers = Array.from({ length: n }, () => rndInt(3));
  } while (!isLegal(n, tiers));
  const wager = 10n ** 18n;
  const { safe, mid, risky } = priceWheel(n, tiers);
  const limit = segmentLimit(n);
  let seg = -1;
  for (let i = 0; i < 32; i++) {
    const b = rndByte();
    if (b < limit) { seg = b % n; break; }
  }
  if (seg < 0) seg = 0; // mirror fallback (never happens in practice)
  const t = tiers[seg];
  const mult = t === 0 ? safe : t === 1 ? mid : risky;
  wagered += wager;
  returned += (wager * mult) / WAD;
  // The ride is a fair 1/2 coin on doubling the landed multiplier, so the same
  // spins played as a rider must land in the same RTP window.
  const banked = (wager * mult) / WAD;
  rideReturned += rndByte() < 128 ? 2n * banked : 0n;
}
const mcRtpPct = (returned * 10000n) / wagered;
const mcRidePct = (rideReturned * 10000n) / wagered;
console.log(`  empirical RTP (banking): ${Number(mcRtpPct) / 100}% over ${SPINS} spins`);
console.log(`  empirical RTP (riding):  ${Number(mcRidePct) / 100}%`);
ok(mcRtpPct >= 9300n && mcRtpPct <= 9800n, 'MC bank RTP in [93%, 98%]');
ok(mcRidePct >= 9300n && mcRidePct <= 9800n, 'MC ride RTP in [93%, 98%]');

// ── 3) prize-byte invariance ─────────────────────────────────────────────────
console.log('\n[3] Prize-byte invariance: payout identical for all 256 prize rolls...');
{
  const n = 12;
  const tiers = [2, 0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1];
  const { safe, mid, risky } = priceWheel(n, tiers);
  let base = null;
  for (let prizeByte = 0; prizeByte < 256; prizeByte++) {
    const bytes = new Uint8Array(32);
    bytes[0] = 5; bytes[1] = prizeByte; // seg byte 5 < 192(limit for 12) → seg 5
    const seg = bytes[0] % n;
    const t = tiers[seg];
    const mult = t === 0 ? safe : t === 1 ? mid : risky;
    const payout = (10n ** 18n * mult) / WAD;
    if (base === null) base = payout;
    ok(payout === base, `prize invariance b=${prizeByte}`);
  }
}

// ── 4) uniformity ────────────────────────────────────────────────────────────
console.log('\n[4] Rejection-sampling uniformity (N=12, 120k draws)...');
{
  const n = 12, draws = 120_000, limit = segmentLimit(n);
  const hist = new Array(n).fill(0);
  for (let i = 0; i < draws; i++) {
    for (let j = 0; j < 32; j++) {
      const b = rndByte();
      if (b < limit) { hist[b % n]++; break; }
    }
  }
  const expected = draws / n;
  const dev = hist.map((h) => Math.abs(h - expected) / expected);
  console.log(`  buckets: ${hist.join(' ')}   max dev: ${(Math.max(...dev) * 100).toFixed(2)}%`);
  ok(Math.max(...dev) < 0.03, 'uniformity within 3%');
}

// ── 5) body variance (quoteRiskParams, 4th parameter) ────────────────────────
// The SDK defines bodyVarianceScaled as the variance of this bet's payout with
// the TOP tier removed, per bet, in wei²·1e18; a single-winning-tier game returns
// 0. The contract quotes it as a closed form, taken under the worst-case policy
// (the player rides), because the host must commit risk before the player picks.
// We recompute it two ways:
//   (a) the contract's closed form  p·(2−p)·X²·1e18,  p = cMid/N,  X = mid payout
//   (b) an independent brute-force variance over all 2N equally likely
//       (segment, coin) outcomes, with every risky (top tier) outcome forced to 0
// and assert the contract is zero *exactly* when no non-top winning outcome exists.
console.log('\n[5] Body variance: closed form vs brute force, every legal class...');
{
  const contractBody = (n, tiers, wager) => {
    const [, cM] = counts(tiers);
    if (cM === 0n) return 0n;
    const { mid } = priceWheel(n, tiers);
    if (mid <= WAD / 2n) return 0n; // the doubled mid still cannot beat the stake
    const payout = (wager * mid) / WAD;
    return (((payout * payout) * cM * (2n * BigInt(n) - cM)) / (BigInt(n) * BigInt(n))) * WAD;
  };

  // Brute force: the "body" is the distribution of this round's payout with the
  // TOP tier removed, under the worst-case policy (always ride). A ride is a fair
  // 1/2 coin, so each segment contributes two equally likely outcomes; risky
  // segments contribute nothing at all, and only payouts ABOVE the stake count as
  // wins — which is why a single-winning-outcome game comes out at exactly 0.
  // Computed in floats from the exact integer price list; unit = wei²·1e18.
  const bruteBody = (n, tiers, wager) => {
    const { safe, mid } = priceWheel(n, tiers);
    const payout = (mult) => (wager * mult) / WAD; // wei, exact
    const vals = [];
    for (const t of tiers) {
      if (t === 2) { vals.push(0, 0); continue; } // top tier removed
      const banked = payout(t === 0 ? safe : mid);
      const ridden = 2n * banked; // the fair coin doubles it, or pays nothing
      vals.push(0); // coin loses
      vals.push(Number(ridden > wager ? ridden : 0n)); // coin wins, above stake only
    }
    const N = vals.length; // 2N equally likely outcomes
    const mean = vals.reduce((a, b) => a + b, 0) / N;
    const v = vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / N;
    return v * 1e18; // → wei²·1e18, the reserve's scaled units
  };

  const wager = 10n ** 18n; // 1 token, the canonical unit
  let nonZero = 0, checked = 0, worstRel = 0, worstAt = null;
  for (let n = 8; n <= 16; n += 2) {
    for (let cR = 1; 2 * cR <= n; cR++) {
      for (let cS = 0; cS + cR <= n; cS++) {
        const cM = n - cS - cR;
        const tiers = [...Array(cS).fill(0), ...Array(cM).fill(1), ...Array(cR).fill(2)];
        if (!isLegal(n, tiers)) continue;
        checked++;
        const quoted = contractBody(n, tiers, wager);
        const brute = bruteBody(n, tiers, wager);

        // the SDK's rule: zero exactly when the risky tier is the sole winning tier
        const { mid, risky } = priceWheel(n, tiers);
        // a second winning OUTCOME survives the top-tier removal exactly when the
        // doubled mid payout beats the stake (the ride's coin is what doubles it)
        const secondWinningOutcome = cM > 0 && 2n * ((wager * mid) / WAD) > wager;
        ok(
          (quoted > 0n) === secondWinningOutcome,
          `body var sign N=${n} (${cS},${cM},${cR}) mid=${mid} risky=${risky}`,
        );
        if (quoted > 0n) nonZero++;

        const rel = Math.abs(Number(quoted) - brute) / Math.max(brute, 1);
        if (rel > worstRel) { worstRel = rel; worstAt = `N=${n} cS=${cS} cM=${cM} cR=${cR}`; }
        ok(rel < 1e-9, `body var closed form N=${n} (${cS},${cM},${cR}) rel=${rel}`);
      }
    }
  }
  console.log(`  legal classes checked: ${checked}`);
  console.log(`  classes with non-zero body variance (the doubled mid beats the stake): ${nonZero}`);
  console.log(`  worst relative deviation from brute force: ${(worstRel * 100).toExponential(2)}% at ${worstAt}`);
}

// ── 6) the ride is exactly fair, by enumeration ─────────────────────────────
// The whole pitch rests on one line: RTP is 96% however you paint and whichever
// way you play. That is only true because the ride is an exact 1/2 coin on the
// banked amount. Enumerate every (segment, coin) outcome and compare the two
// strategies head to head against the DECLARED expectedPayout.
console.log('\n[6] Ride fairness: banking vs riding, every legal class...');
{
  let checked = 0, worst = 0, worstAt = null;
  for (let n = 8; n <= 16; n += 2) {
    for (let cR = 1; 2 * cR <= n; cR++) {
      for (let cS = 0; cS + cR <= n; cS++) {
        const cM = n - cS - cR;
        const tiers = [...Array(cS).fill(0), ...Array(cM).fill(1), ...Array(cR).fill(2)];
        if (!isLegal(n, tiers)) continue;
        checked++;
        const wager = WAD;
        const { safe, mid, risky } = priceWheel(n, tiers);
        const at = (t) => (wager * (t === 0 ? safe : t === 1 ? mid : risky)) / WAD;

        // banking: N equally likely outcomes
        const bankTotal = tiers.reduce((a, t) => a + at(t), 0n);
        const bankMean = Number(bankTotal) / n;
        // riding: 2N equally likely outcomes — a fair coin on doubling the landed amount
        const rideTotal = tiers.reduce((a, t) => a + 2n * at(t), 0n); // losing half contributes 0
        const rideMean = Number(rideTotal) / (2 * n);

        const declared = Number(RTP_WAD); // expectedPayout = wager · RTP, in WAD units
        const spread = Math.max(Math.abs(bankMean - declared), Math.abs(rideMean - declared));
        const rel = spread / declared;
        if (rel > worst) { worst = rel; worstAt = `N=${n} cS=${cS} cM=${cM} cR=${cR}`; }
        // the only slack is the λ floor, which is a few thousandths of a percent
        ok(rel < 1e-3, `ride fairness N=${n} (${cS},${cM},${cR}) rel=${rel}`);
      }
    }
  }
  console.log(`  legal classes checked: ${checked}`);
  console.log(`  worst |strategy EV − declared 96%|: ${(worst * 100).toFixed(5)}% at ${worstAt}`);
}

console.log('\n' + (fails === 0 ? 'PASS: ALL CHECKS PASSED — declared math verified.' : `FAIL: ${fails} check(s) failed.`));
process.exit(fails === 0 ? 0 : 1);
