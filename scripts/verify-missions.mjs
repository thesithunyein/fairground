// FAIRGROUND daily missions and ladder verifier.
// Run: npm run verify:missions
//
// The mission rules are pure functions, so they get a real test rather than a
// promise. Runs in plain Node: the TypeScript module is transpiled with the
// esbuild that already ships with Vite, then imported.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transform } from 'esbuild';

const SOURCE = 'src/lib/missions.ts';
const source = readFileSync(SOURCE, 'utf8');

let pass = 0;
let fail = 0;
function check(ok, label, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`);
  }
}

// ── load the module ─────────────────────────────────────────────────────────
const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
const dir = mkdtempSync(join(tmpdir(), 'fg-missions-'));
const file = join(dir, 'missions.mjs');
writeFileSync(file, code);
const m = await import(`file://${file.replace(/\\/g, '/')}`);

const {
  dailyMissions, recordMetric, missionProgress, allMissionsDone,
  emptyDaily, rollDaily, emptyLadder, completeDay, previousDayKey,
  rewardForDay, LADDER, LADDER_LENGTH, MISSION_POOL,
} = m;

console.log('\nFAIRGROUND · daily missions and ladder\n');

console.log('[1] daily board is deterministic and varied');
const day = '2026-09-12';
const a = dailyMissions(day);
const b = dailyMissions(day);
check(JSON.stringify(a) === JSON.stringify(b), 'same day key yields the same board');
check(a.length === 3, 'three objectives a day', `got ${a.length}`);
check(new Set(a.map(x => x.id)).size === 3, 'objectives are distinct');
check(new Set(a.map(x => x.theme)).size === 3, 'no two objectives share a theme (three different asks)');
check(new Set(a.map(x => x.family)).size === 3, 'no two objectives share a family (no overlap)');

const boards = new Set();
const seen = new Set();
let riskCollisions = 0;
for (let i = 0; i < 365; i += 1) {
  const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
  const board = dailyMissions(d);
  boards.add(board.map(x => x.id).join(','));
  board.forEach(x => seen.add(x.id));
  if (new Set(board.map(x => x.theme)).size !== board.length) riskCollisions += 1;
}
check(boards.size >= 60, 'a year of days gives many distinct boards', `${boards.size} boards`);
check(riskCollisions === 0, 'a year of boards never repeats a theme inside one day', `${riskCollisions} colliding days`);
check(seen.size === MISSION_POOL.length, 'every objective in the pool is reachable', `${seen.size}/${MISSION_POOL.length}`);

console.log('\n[2] progress tracking');
const base = emptyDaily(day);
const after = recordMetric(base, 'spins', 1);
check(base.metrics.spins === undefined, 'recordMetric does not mutate the old state');
check(after.metrics.spins === 1, 'recordMetric increments');
check(recordMetric(after, 'spins', 4).metrics.spins === 5, 'recordMetric accumulates');
check(rollDaily(base, '2026-09-13').metrics.spins === undefined, 'a new day clears progress');
check(rollDaily(base, day) === base, 'the same day keeps progress');

const spinsMission = { id: 'x', label: 'x', metric: 'spins', target: 3, theme: 'volume', family: 'volume' };
check(missionProgress(spinsMission, emptyDaily(day)).done === false, 'objective starts incomplete');
check(missionProgress(spinsMission, recordMetric(base, 'spins', 2)).done === false, 'incomplete below target');
check(missionProgress(spinsMission, recordMetric(base, 'spins', 3)).done === true, 'complete at target');
check(missionProgress(spinsMission, recordMetric(base, 'spins', 9)).done === true, 'stays complete above target');

console.log('\n[3] a day only banks when every objective is met');
const board = dailyMissions(day);
let daily = emptyDaily(day);
let ladder = emptyLadder();
check(completeDay(daily, ladder, board, day).awarded === null, 'nothing awarded while objectives are open');

for (const mission of board) daily = recordMetric(daily, mission.metric, mission.target);
check(allMissionsDone(board, daily) === true, 'all objectives met once targets are reached');
const banked = completeDay(daily, ladder, board, day);
check(banked.awarded !== null, 'the first completed day pays a reward');
check(banked.ladder.day === 1, 'the run starts on rung one');
check(completeDay(banked.daily, banked.ladder, board, day).awarded === null, 'the same day cannot pay twice');

console.log('\n[4] the ladder climbs on consecutive days and resets on a miss');
function completeOn(state, dayKey) {
  const b = dailyMissions(dayKey);
  let d = emptyDaily(dayKey);
  for (const mission of b) d = recordMetric(d, mission.metric, mission.target);
  return completeDay(d, state, b, dayKey);
}
let run = { daily: emptyDaily(day), ladder: banked.ladder };
const days = ['2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'];
for (const d of days) run = completeOn(run.ladder, d);
check(run.ladder.day === 7, 'seven consecutive days reach rung seven', `day ${run.ladder.day}`);
check(run.ladder.badges.length === 7, 'seven rewards banked');
check(run.ladder.badges[6] === 'gilded', 'rung seven awards the gilded wheel');
check(run.ladder.badges.filter(x => x === 'gilded').length === 1, 'the trophy is awarded once per run');

const afterWrap = completeOn(run.ladder, '2026-09-19');
check(afterWrap.ladder.day === 1, 'finishing the ladder starts a fresh run');
check(afterWrap.ladder.runs === 1, 'the completed cycle is counted');
check(afterWrap.awarded.id === 'badge-brass', 'the new run starts on the brass rung');

const skipped = completeOn(banked.ladder, '2026-09-20');
check(skipped.ladder.day === 1, 'a skipped day drops the run back to rung one');

check(previousDayKey('2026-09-12') === '2026-09-11', 'previous day steps back one');
check(previousDayKey('2026-03-01') === '2026-02-28', 'previous day handles a month boundary');
check(previousDayKey('2026-01-01') === '2025-12-31', 'previous day handles a year boundary');

console.log('\n[5] rewards are cosmetic only');
const rewardIds = new Set(LADDER.map(r => r.id));
check(rewardIds.size === LADDER_LENGTH, 'reward ids are unique');
const moneyWords = /\b(payout|multiplier|rtp|wager|bet|balance|odds|segment)\b/i;
const offenders = LADDER.filter(r => moneyWords.test(`${r.id} ${r.label}`));
check(offenders.length === 0, 'no reward names a money concept', offenders.map(o => o.id).join(','));
check(rewardForDay(1).kind === 'badge' && rewardForDay(7).kind === 'wheel', 'rewards are stamps and one wheel skin');
const sourceMoney = source.split('\n').filter(l => !l.trim().startsWith('//') && moneyWords.test(l));
check(sourceMoney.length === 0, 'the module never reads game maths or money state', sourceMoney[0] ?? '');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
