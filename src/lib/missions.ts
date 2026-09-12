// FAIRGROUND: daily missions and a seven day cosmetic ladder.
//
// Everything in this file is cosmetic. No reward here can touch a multiplier,
// a payout or an outcome, and nothing in it reads the game maths. The RTP is
// fixed at 96% for every legal paint no matter how much of this a player
// completes, which is the property the repo's fairness claims depend on.
//
// The logic is deliberately pure: state in, state out, day keys passed in by
// the caller. Storage is a thin wrapper at the bottom so the rules can be
// tested without a browser (see scripts/verify-missions.mjs).

export type Metric =
  | 'spins'
  | 'wins'
  | 'riskyLands'
  | 'riskyWins'
  | 'legendaryPrizes'
  | 'setsCompleted'
  | 'shareCopied';

export type Mission = {
  id: string;
  label: string;
  metric: Metric;
  target: number;
  /** missions in one theme are never offered together, so a day's three
   *  objectives always ask for three different things. */
  theme: string;
  /** two missions in one family are never offered together either, which
   *  keeps the theme from asking the same thing at two sizes
   *  (no "spin 15" next to "spin 30"). */
  family: string;
};

/**
 * The pool. Targets are tuned to be reachable inside one sitting: at roughly
 * four seconds a spin, fifteen spins is about a minute of actual play.
 */
export const MISSION_POOL: Mission[] = [
  { id: 'spins15', label: 'Spin 15 times', metric: 'spins', target: 15, theme: 'volume', family: 'volume' },
  { id: 'spins30', label: 'Spin 30 times', metric: 'spins', target: 30, theme: 'volume', family: 'volume' },
  { id: 'wins5', label: 'Win 5 spins', metric: 'wins', target: 5, theme: 'wins', family: 'wins' },
  { id: 'wins10', label: 'Win 10 spins', metric: 'wins', target: 10, theme: 'wins', family: 'wins' },
  { id: 'risky3', label: 'Land on risky 3 times', metric: 'riskyLands', target: 3, theme: 'risk', family: 'risk' },
  { id: 'risky6', label: 'Land on risky 6 times', metric: 'riskyLands', target: 6, theme: 'risk', family: 'risk' },
  { id: 'riskyWin1', label: 'Win on a risky slice', metric: 'riskyWins', target: 1, theme: 'risk', family: 'riskWin' },
  { id: 'riskyWin3', label: 'Win on risky 3 times', metric: 'riskyWins', target: 3, theme: 'risk', family: 'riskWin' },
  { id: 'legendary1', label: 'Collect a legendary prize', metric: 'legendaryPrizes', target: 1, theme: 'trophy', family: 'trophy' },
  { id: 'set1', label: 'Complete a prize set', metric: 'setsCompleted', target: 1, theme: 'set', family: 'set' },
  { id: 'share1', label: 'Copy your wheel link', metric: 'shareCopied', target: 1, theme: 'social', family: 'social' },
];

/** Deterministic 32 bit FNV-1a. Same day key always yields the same missions. */
export function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const THEMES = [...new Set(MISSION_POOL.map(m => m.theme))];

/**
 * The day's three objectives. Deterministic in the day key, so every player
 * sees the same board on the same day and a reload never rerolls it.
 */
export function dailyMissions(dayKey: string, count = 3): Mission[] {
  const picked: { theme: string; rank: number }[] = [];
  for (const theme of THEMES) {
    picked.push({ theme, rank: hash(`${dayKey}|${theme}`) });
  }
  return picked
    .sort((a, b) => a.rank - b.rank)
    .slice(0, count)
    .map((entry) => {
      const options = MISSION_POOL.filter(m => m.theme === entry.theme);
      return options[hash(`${dayKey}|${entry.theme}|pick`) % options.length];
    });
}

// ── daily state ─────────────────────────────────────────────────────────────

export type DailyState = {
  /** YYYY-MM-DD this state belongs to; a mismatch means it has rolled over */
  dayKey: string;
  metrics: Partial<Record<Metric, number>>;
  /** every objective met today */
  dayComplete: boolean;
};

export function emptyDaily(dayKey: string): DailyState {
  return { dayKey, metrics: {}, dayComplete: false };
}

/** Roll the daily board over when the date changes. */
export function rollDaily(state: DailyState, dayKey: string): DailyState {
  if (state.dayKey === dayKey) return state;
  return emptyDaily(dayKey);
}

export function recordMetric(state: DailyState, metric: Metric, amount = 1): DailyState {
  return {
    ...state,
    metrics: { ...state.metrics, [metric]: (state.metrics[metric] ?? 0) + amount },
  };
}

export function missionProgress(mission: Mission, state: DailyState): { have: number; target: number; done: boolean } {
  const have = state.metrics[mission.metric] ?? 0;
  return { have, target: mission.target, done: have >= mission.target };
}

export function allMissionsDone(missions: Mission[], state: DailyState): boolean {
  return missions.every(m => missionProgress(m, state).done);
}

// ── the seven day ladder ────────────────────────────────────────────────────

export type Reward = { day: number; id: string; label: string; kind: 'badge' | 'wheel' };

export const LADDER: Reward[] = [
  { day: 1, id: 'badge-brass', label: 'Brass stamp', kind: 'badge' },
  { day: 2, id: 'badge-copper', label: 'Copper stamp', kind: 'badge' },
  { day: 3, id: 'badge-silver', label: 'Silver stamp', kind: 'badge' },
  { day: 4, id: 'badge-gold', label: 'Gold stamp', kind: 'badge' },
  { day: 5, id: 'badge-emerald', label: 'Emerald stamp', kind: 'badge' },
  { day: 6, id: 'badge-ruby', label: 'Ruby stamp', kind: 'badge' },
  { day: 7, id: 'gilded', label: 'Gilded wheel', kind: 'wheel' },
];

export const LADDER_LENGTH = LADDER.length;

export type LadderState = {
  /** 1..7, the day of the current run; 0 before the first ever completion */
  day: number;
  /** day key of the last completed day, used to require consecutive days */
  lastCompletedDayKey: string | null;
  /** reward ids earned, in order */
  badges: string[];
  /** completed seven day runs */
  runs: number;
};

export function emptyLadder(): LadderState {
  return { day: 0, lastCompletedDayKey: null, badges: [], runs: 0 };
}

/** Previous calendar day for a YYYY-MM-DD key (UTC, matching dayKey()). */
export function previousDayKey(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const t = Date.UTC(y, (m ?? 1) - 1, d ?? 1) - 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function rewardForDay(day: number): Reward {
  return LADDER[Math.min(Math.max(day, 1), LADDER_LENGTH) - 1];
}

/**
 * A day is banked when all three objectives are met. Consecutive days climb
 * the ladder; a missed day drops the run back to the first rung, which is the
 * habit mechanic the social casino genre leans on. Finishing rung seven starts
 * a fresh run and counts a completed cycle.
 */
export function completeDay(
  daily: DailyState,
  ladder: LadderState,
  missions: Mission[],
  dayKey: string,
): { daily: DailyState; ladder: LadderState; awarded: Reward | null } {
  if (!allMissionsDone(missions, daily)) return { daily, ladder, awarded: null };
  if (daily.dayComplete) return { daily, ladder, awarded: null };

  const consecutive = ladder.lastCompletedDayKey === previousDayKey(dayKey);
  const nextDay = consecutive ? ladder.day + 1 : 1;
  // Finishing rung seven starts a fresh run on rung one, so the reward always
  // belongs to the rung you land on rather than repeating the trophy.
  const wrapped = nextDay > LADDER_LENGTH;
  const landedOn = wrapped ? 1 : nextDay;
  const awarded = rewardForDay(landedOn);

  return {
    daily: { ...daily, dayComplete: true },
    ladder: {
      day: landedOn,
      lastCompletedDayKey: dayKey,
      badges: [...ladder.badges, awarded.id],
      runs: ladder.runs + (wrapped ? 1 : 0),
    },
    awarded,
  };
}

// ── storage (thin, and the only part that touches the browser) ──────────────

const DAILY_KEY = 'fg_daily_v1';
const LADDER_KEY = 'fg_ladder_v1';

export function loadDaily(dayKey: string): DailyState {
  try {
    const raw = localStorage.getItem(DAILY_KEY);
    if (!raw) return emptyDaily(dayKey);
    const parsed = JSON.parse(raw) as DailyState;
    return rollDaily(
      {
        dayKey: typeof parsed.dayKey === 'string' ? parsed.dayKey : dayKey,
        metrics: typeof parsed.metrics === 'object' && parsed.metrics ? parsed.metrics : {},
        dayComplete: parsed.dayComplete === true,
      },
      dayKey,
    );
  } catch {
    return emptyDaily(dayKey);
  }
}

export function saveDaily(state: DailyState): void {
  try {
    localStorage.setItem(DAILY_KEY, JSON.stringify(state));
  } catch {
    /* private mode: missions simply will not persist */
  }
}

export function loadLadder(): LadderState {
  try {
    const raw = localStorage.getItem(LADDER_KEY);
    if (!raw) return emptyLadder();
    const parsed = JSON.parse(raw) as LadderState;
    return {
      day: typeof parsed.day === 'number' ? parsed.day : 0,
      lastCompletedDayKey:
        typeof parsed.lastCompletedDayKey === 'string' ? parsed.lastCompletedDayKey : null,
      badges: Array.isArray(parsed.badges) ? parsed.badges : [],
      runs: typeof parsed.runs === 'number' ? parsed.runs : 0,
    };
  } catch {
    return emptyLadder();
  }
}

export function saveLadder(state: LadderState): void {
  try {
    localStorage.setItem(LADDER_KEY, JSON.stringify(state));
  } catch {
    /* private mode */
  }
}
