// Fairground → Chain graph-engine fair ladder: math check (no SDK needed).
// For every legal paint composition (N, cSafe, cMid, cRisky) this computes the
// entry prizes in integer prize units (floored, as the engine requires), the
// resulting RTP, and how many fair x2 RIDEs each tier allows under the cap.
//
// Usage: node scripts/ladder-math.mjs [prizeDenominator] [capMultiplier] [--json]
const D = BigInt(process.argv[2] ?? 10000);      // prize units per 1x wager
const CAP_X = Number(process.argv[3] ?? 100);     // ladder cap, in x wager
const CAP = BigInt(CAP_X) * D;
const RTP_TARGET_NUM = 96n, RTP_TARGET_DEN = 100n; // 0.96
const SAFE = D / 5n;                              // 0.2x anchor, exact for D%5==0
const APPROVAL_CEILING = 0.98;

const configs = [];
for (const N of [8, 10, 12, 14, 16]) {
  for (let cR = 1; 2 * cR <= N; cR++) {
    for (let cM = 0; cM + cR <= N; cM++) {
      const cS = N - cR - cM;
      if (cS + cM < 1) continue;
      // lambda = (0.96N - 0.2cS) / (2cM + 6cR), in prize units, exact rational.
      // mid = 2*lambda, risky = 6*lambda, floored to whole prize units.
      const num = (RTP_TARGET_NUM * BigInt(N) * D) / RTP_TARGET_DEN * 1n; // 0.96*N*D (exact when D%25==0)
      const lamNum = num - SAFE * BigInt(cS);
      const lamDen = BigInt(2 * cM + 6 * cR);
      const mid = (2n * lamNum) / lamDen;
      const risky = (6n * lamNum) / lamDen;
      const total = SAFE * BigInt(cS) + mid * BigInt(cM) + risky * BigInt(cR);
      const rtp = Number(total) / Number(D) / N;
      const ridesFor = (p) => { let k = 0, v = p; while (v * 2n < CAP) { v *= 2n; k++; } return k; };
      configs.push({ N, cS, cM, cR, safe: SAFE, mid, risky, rtp,
        ridesSafe: ridesFor(SAFE), ridesMid: cM ? ridesFor(mid) : null, ridesRisky: ridesFor(risky),
        entryHitsCap: risky >= CAP });
    }
  }
}

// --json: print every configuration for scripts/check-title.ts to compare against the engine.
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(configs, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  process.exit(0);
}

const rtps = configs.map(c => c.rtp);
const bad = configs.filter(c => c.rtp > APPROVAL_CEILING || c.rtp >= 1 || c.entryHitsCap || 2n * D > CAP);
const fmt = (u) => (Number(u) / Number(D)).toFixed(4) + 'x';
console.log(`prizeDenominator=${D}  cap=${CAP_X}x  configurations=${configs.length}`);
console.log(`RTP min=${(Math.min(...rtps) * 100).toFixed(4)}%  max=${(Math.max(...rtps) * 100).toFixed(4)}%`);
const maxRisky = configs.reduce((a, c) => (c.risky > a.risky ? c : a));
console.log(`largest entry prize: ${fmt(maxRisky.risky)} (N=${maxRisky.N}, cR=${maxRisky.cR}) -> rides allowed ${maxRisky.ridesRisky}`);
const minRides = Math.min(...configs.map(c => c.ridesRisky));
console.log(`rides allowed: safe 0.2x=${configs[0].ridesSafe}, risky slices min=${minRides} max=${Math.max(...configs.map(c => c.ridesRisky))}`);
console.log(bad.length ? `FAIL: ${bad.length} configurations break a rule` : 'OK: every configuration <= 98% RTP, < 100%, entry below cap, cap >= 2x base');
process.exit(bad.length ? 1 : 0);
