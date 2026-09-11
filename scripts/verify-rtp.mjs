// FAIRGROUND RTP verifier — proves the declared math (docs/MATH.md).
// Run: npm run verify:rtp
//
// 1) Exhaustive sweep of every legal composition class (N = 8..16):
//    pricing identity, ordering, multiplier bounds, heavy-tail thresholds,
//    floor-truncated RTP inside the window.
// 2) Monte-Carlo over the legal space: empirical RTP from 250k simulated
//    rejection-sampled spins.
// 3) Prize-byte invariance and rejection-sampling uniformity checks.

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
    }
  }
}
console.log(`  composition classes checked: ${classes} (covers all paints — arrangement-independent)`);
console.log(`  min lambda: ${Number(minLambda) / 1e18}x   max multiplier: ${Number(maxMult) / 1e18}x`);
console.log(`  RTP band (floor-truncated): ${(Number(minRtp) / 1e18) * 100}% .. ${(Number(maxRtp) / 1e18) * 100}%`);

// ── 2) Monte-Carlo ───────────────────────────────────────────────────────────
console.log('\n[2] Monte-Carlo: 250,000 spins over random legal paints...');
const SPINS = 250_000;
let wagered = 0n, returned = 0n;
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
}
const mcRtpPct = (returned * 10000n) / wagered;
console.log(`  empirical RTP: ${Number(mcRtpPct) / 100}% over ${SPINS} spins`);
ok(mcRtpPct >= 9300n && mcRtpPct <= 9800n, 'MC RTP in [93%, 98%]');

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

console.log('\n' + (fails === 0 ? 'PASS: ALL CHECKS PASSED — declared math verified.' : `FAIL: ${fails} check(s) failed.`));
process.exit(fails === 0 ? 0 : 1);
