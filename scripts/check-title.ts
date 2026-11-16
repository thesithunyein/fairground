// FAIRGROUND engine check: compiles src/title.ts with the casino SDK's graph compiler, the same
// compiler the developer platform runs, and holds every configuration to scripts/ladder-math.mjs.
//
// Run: npm run check:title   (Node 22.18+ loads the TypeScript directly)
//
// For each of the 300 paint compositions it checks that:
//   1. the composition and its floored entry prizes are the ones ladder-math.mjs computes;
//   2. the engine's RTP is at most 98% and within 0.0001 percentage points of the RTP the
//      floored prizes actually return (the engine reports 96.00%, see docs/MATH.md);
//   3. every cash-out the engine pays is floor(wager × prize / 1e6) or at most one base unit
//      below it, never above: the engine holds the multiplier in 1e18 fixed point, and
//      prize / 0.96 is not always exact there;
//   4. the rides the engine allows before the 100x cap match ladder-math.mjs for each tier;
//   5. random sessions replayed with walkLadder settle as the floored prizes say.
import { execFileSync } from 'node:child_process';
import { keccak256, toHex } from 'viem';
import {
  compileGraphGame,
  graphQuoteTable,
  ladderOptionPassesCap,
  ladderPayout,
  quoteConfiguration,
  walkLadder,
  type LadderAction,
  type LadderNode,
} from '@chain-protocol/casino-sdk/graph-engine';
import fairground, {
  BASE_PRIZE,
  CAP_PRIZE,
  COMPOSITIONS,
  LABEL,
  PRIZE_DENOMINATOR,
  RATIO_DENOMINATOR,
  entryPrizes,
} from '../src/title.ts';

const WAD = 10n ** 18n;
const D = PRIZE_DENOMINATOR;
const RTP_TOLERANCE_WAD = 10n ** 12n; // 0.0001 percentage points = 1e-6 of the wager
const APPROVAL_CEILING_WAD = 98n * 10n ** 16n;

let failures = 0;
const fail = (message: string) => {
  failures++;
  if (failures <= 20) console.error(`  FAIL ${message}`);
};

type MathConfig = {
  N: number; cS: number; cM: number; cR: number;
  safe: string; mid: string; risky: string; rtp: number;
  ridesSafe: number; ridesMid: number | null; ridesRisky: number;
};

// 0. The reference math passes its own rules, and its configurations are the reference.
execFileSync(process.execPath, ['scripts/ladder-math.mjs', D.toString(), (CAP_PRIZE / D).toString()], { stdio: 'inherit' });
const reference: MathConfig[] = JSON.parse(
  execFileSync(process.execPath, ['scripts/ladder-math.mjs', D.toString(), (CAP_PRIZE / D).toString(), '--json'], { encoding: 'utf8' }),
);

const started = performance.now();
const compiled = compileGraphGame(fairground);
const { graph, derived } = compiled;
console.log(`compiled ${derived.configurations.length} configurations, ${graph.nodes.length} nodes in ${(performance.now() - started).toFixed(0)} ms`);
if (derived.configurations.length !== reference.length) fail(`engine has ${derived.configurations.length} configurations, ladder-math.mjs ${reference.length}`);

const quoteTable = graphQuoteTable(compiled);
// The engine's entry and ride: multiplierWad scales by ratio / ratioDenominator, floored.
const scaled = (multiplierWad: bigint, ratio: bigint) => (multiplierWad * ratio) / RATIO_DENOMINATOR;
const ridesAllowed = (ladder: LadderNode, entryMultiplierWad: bigint) => {
  const ride = ladder.rungs[0].options[0];
  let rides = 0;
  for (let m = entryMultiplierWad; !ladderOptionPassesCap(ladder, ride, m); m = scaled(m, 2n * RATIO_DENOMINATOR)) rides++;
  return rides;
};
const WAGERS = [1n, 7n, 999_999n, D, 3n * D, 12_345_678n, 10n ** 9n, 10n ** 12n];

let engineRtpMin = WAD, engineRtpMax = 0n, flooredRtpMin = WAD, flooredRtpMax = 0n;
let exactPayouts = 0, oneUnitShort = 0;

COMPOSITIONS.forEach((c, i) => {
  const ref = reference[i];
  const where = `configuration ${i} (N=${c.n} safe=${c.cSafe} mid=${c.cMid} risky=${c.cRisky})`;
  if (!ref || ref.N !== c.n || ref.cS !== c.cSafe || ref.cM !== c.cMid || ref.cR !== c.cRisky) {
    fail(`${where}: ladder-math.mjs lists ${JSON.stringify(ref && [ref.N, ref.cS, ref.cM, ref.cR])} here`);
    return;
  }

  // 1. The entry prizes are ladder-math.mjs's floored prizes, to the prize unit.
  const prizes = entryPrizes(c);
  if (prizes.safe !== BigInt(ref.safe) || prizes.mid !== BigInt(ref.mid) || prizes.risky !== BigInt(ref.risky)) {
    fail(`${where}: prizes ${prizes.safe}/${prizes.mid}/${prizes.risky}, ladder-math.mjs ${ref.safe}/${ref.mid}/${ref.risky}`);
  }

  // 2. RTP: the engine's against the floored prizes'.
  const figures = derived.configurations[i];
  const total = prizes.safe * BigInt(c.cSafe) + prizes.mid * BigInt(c.cMid) + prizes.risky * BigInt(c.cRisky);
  const flooredRtpWad = (total * WAD) / (D * BigInt(c.n));
  const gap = figures.rtpWad - flooredRtpWad;
  if (figures.rtpWad > APPROVAL_CEILING_WAD) fail(`${where}: engine RTP ${figures.rtpWad} above the 98% ceiling`);
  if (gap < 0n || gap > RTP_TOLERANCE_WAD) fail(`${where}: engine RTP ${figures.rtpWad} vs floored ${flooredRtpWad}, gap ${gap}`);
  if (Math.abs(Number(flooredRtpWad) / 1e18 - ref.rtp) > 1e-12) fail(`${where}: floored RTP disagrees with ladder-math.mjs`);
  engineRtpMin = figures.rtpWad < engineRtpMin ? figures.rtpWad : engineRtpMin;
  engineRtpMax = figures.rtpWad > engineRtpMax ? figures.rtpWad : engineRtpMax;
  flooredRtpMin = flooredRtpWad < flooredRtpMin ? flooredRtpWad : flooredRtpMin;
  flooredRtpMax = flooredRtpWad > flooredRtpMax ? flooredRtpWad : flooredRtpMax;

  // The quote the engine opens a session with: expected payout 0.96 x wager.
  const quote = quoteConfiguration(quoteTable, i, D);
  if (quote.expectedPayout !== (D * BASE_PRIZE) / D) fail(`${where}: expected payout ${quote.expectedPayout} on a 1e6 wager`);

  // 3 and 4. Every tier's cash-outs, and its rides under the cap.
  const ladder = graph.nodes[graph.roots[i]] as LadderNode;
  const tiers: [bigint, number | null, number][] = [
    [prizes.safe, c.cSafe ? ref.ridesSafe : null, c.cSafe],
    [prizes.mid, ref.ridesMid, c.cMid],
    [prizes.risky, ref.ridesRisky, c.cRisky],
  ];
  for (const [prize, refRides, count] of tiers) {
    if (count === 0) continue;
    let multiplierWad = scaled(WAD, prize);
    const rides = ridesAllowed(ladder, multiplierWad);
    if (refRides !== null && rides !== refRides) fail(`${where}: prize ${prize} allows ${rides} rides, ladder-math.mjs ${refRides}`);
    for (let k = 0; k <= rides; k++, multiplierWad = scaled(multiplierWad, 2n * RATIO_DENOMINATOR)) {
      for (const wager of WAGERS) {
        const paid = ladderPayout(ladder, D, multiplierWad, wager);
        const want = (wager * prize * 2n ** BigInt(k)) / D;
        if (paid === want) exactPayouts++;
        else if (paid === want - 1n) oneUnitShort++;
        else fail(`${where}: prize ${prize} after ${k} rides pays ${paid} on ${wager}, floored prize says ${want}`);
      }
    }
  }
});

// 5. Random sessions through the engine's own walk.
let sessions = 0;
for (let s = 0; s < 3000; s++) {
  const word = (salt: string) => keccak256(toHex(`fairground-check-${s}-${salt}`));
  const configuration = s % COMPOSITIONS.length;
  const c = COMPOSITIONS[configuration];
  const prizes = entryPrizes(c);
  const root = graph.roots[configuration];
  const wager = WAGERS[s % WAGERS.length];
  const plannedRides = s % 5; // 0 banks at once; otherwise rides up to this many times, then banks
  const actions: LadderAction[] = [];
  let walk = walkLadder(graph, root, word('entry'), actions, wager);
  while (walk.status === 'waiting' && actions.length < plannedRides) {
    actions.push({ option: 0, randomness: word(`ride-${actions.length}`) });
    walk = walkLadder(graph, root, word('entry'), actions, wager);
  }
  if (walk.status === 'waiting') walk = walkLadder(graph, root, word('entry'), [...actions, 'cashOut'], wager);
  if (walk.status !== 'settled') { fail(`session ${s} did not settle`); continue; }

  const [tierLabel, ...rideLabels] = walk.labels;
  const prize = tierLabel === LABEL.safe ? prizes.safe : tierLabel === LABEL.mid ? prizes.mid : prizes.risky;
  const lost = rideLabels.includes(LABEL.lose);
  const wins = rideLabels.filter(label => label === LABEL.win).length;
  const want = lost ? 0n : (wager * prize * 2n ** BigInt(wins)) / D;
  if (walk.payout !== want && walk.payout !== want - 1n) fail(`session ${s}: paid ${walk.payout}, floored prize says ${want}`);
  sessions++;
}

const pct = (wad: bigint) => `${(Number(wad) / 1e16).toFixed(4)}%`;
console.log(`engine RTP  ${pct(engineRtpMin)} .. ${pct(engineRtpMax)}   floored prizes return ${pct(flooredRtpMin)} .. ${pct(flooredRtpMax)}`);
console.log(`cash-outs   ${exactPayouts} exact, ${oneUnitShort} one base unit under the floored prize, none over`);
console.log(`sessions    ${sessions} random walkLadder sessions settled as the floored prizes say`);
if (failures) {
  console.error(`FAIL: ${failures} checks failed`);
  process.exit(1);
}
console.log('OK: every configuration matches ladder-math.mjs, RTP <= 98%, payouts never above the floored prizes');
