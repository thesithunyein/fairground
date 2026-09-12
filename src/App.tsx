import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { computeMaxWager } from './chain-sdk/guest';
import {
  defaultPaint,
  encodeGameData,
  outcomeFromRandomness,
  priceWheel,
  formatMultiplier,
  isLegalPaint,
  decodeGameData,
  demoRandomness,
  demoSeed,
  presetPaint,
  presetOf,
  tierCounts,
  PAINT_PRESETS,
  type Paint,
  type PaintPresetId,
  type Tier,
} from './lib/game';
import {
  LADDER,
  allMissionsDone,
  completeDay,
  dailyMissions,
  loadDaily,
  loadLadder,
  missionProgress,
  recordMetric,
  rollDaily,
  saveDaily,
  saveLadder,
  type DailyState,
  type LadderState,
  type Metric,
} from './lib/missions';
import { useCasinoHost } from './lib/useCasinoHost';
import { Wheel } from './components/Wheel';
import { PrizeSprite, BootWheel, WheelBadge } from './components/Prizes';
import {
  albumProgress,
  loadCollection,
  saveCollection,
  addToCollection,
  SETS,
  LIVERIES,
  TOY_NAMES,
  unlockedLiveries,
  withStamp,
  withTrophy,
  shelfStats,
  type Collection,
  type ToyRarity,
} from './lib/collection';
import * as sfx from './lib/sound';

const DEMO_BALANCE_START = 1000_000000n; // 1000.00 (6 decimals)
// capture mode: ?clean=1 hides the demo ticket stamp while recording promo footage
// (cosmetic only: demo play itself is unchanged, and the normal page keeps the stamp)
const CLEAN_MODE = new URLSearchParams(window.location.search).has('clean');
/**
 * The booth is three screens rather than one long page, the way a real game
 * app is laid out: PLAY holds the table and the bet, COLLECT holds the album,
 * DAILY holds the objectives and the ladder. Only the active screen is in the
 * document, so a phone never has to scroll past one screen to reach another.
 */
type ScreenId = 'play' | 'collect' | 'daily';

const SCREENS: { id: ScreenId; label: string; icon: string }[] = [
  { id: 'play', label: 'Play', icon: '🎡' },
  { id: 'collect', label: 'Collect', icon: '🧸' },
  { id: 'daily', label: 'Daily', icon: '🎟️' },
];

/**
 * Short haptics where the platform actually has them. Android Chrome supports
 * the Vibration API; iOS Safari does not implement it at all, so this is a
 * bonus on one platform and never something the game depends on. Muting the
 * sound is treated as "do not buzz me either".
 */
function buzz(pattern: number | number[]) {
  if (sfx.isMuted()) return;
  const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
  try { nav.vibrate?.(pattern); } catch { /* no haptics on this device */ }
}

const PHASE_WAITING_RANDOMNESS = 2;
const PHASE_SETTLED = 3;
const PHASE_FORFEITED = 4;
const PHASE_CANCELLED = 5;
const isTerminal = (p: number | undefined) => p === PHASE_SETTLED || p === PHASE_FORFEITED || p === PHASE_CANCELLED;

// ── session stats & milestones (client-only cosmetics) ─────────────────
type Stats = {
  spins: number;
  streak: number; // consecutive winning spins
  bestWin: string; // formatted, e.g. "2.58"
  milestones: string[]; // ids already celebrated
  lastPlayDay: string; // YYYY-MM-DD
  dailyStreak: number;
};

const STATS_KEY = 'fg_stats_v1';
const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

function loadStats(): Stats {
  const base: Stats = { spins: 0, streak: 0, bestWin: '0', milestones: [], lastPlayDay: '', dailyStreak: 0 };
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) return base;
    const s = { ...base, ...JSON.parse(raw) } as Stats;
    const today = dayKey();
    if (s.lastPlayDay && s.lastPlayDay !== today) {
      const yest = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
      s.dailyStreak = s.lastPlayDay === yest ? s.dailyStreak : 0;
    }
    return s;
  } catch { return base; }
}

function saveStats(s: Stats) {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

// shareable wheels: pack the paint into the ?wheel= URL param
function paintToUrlParam(p: Paint): string {
  return encodeGameData(p).slice(2); // strip 0x
}

function paintFromUrlParam(param: string | null): Paint | null {
  if (!param || !/^[0-9a-fA-F]{18}$/.test(param)) return null;
  try { return decodeGameData((`0x${param}`) as never); } catch { return null; }
}

type Round = {
  sessionKey?: string;
  sessionId?: string;
  wager: bigint;
  paint: Paint;
  /** true until openSession resolves with a sessionKey */
  pending: boolean;
};

type Result = {
  segment: number;
  tier: Tier;
  payout: bigint;
  won: boolean;
  prize: { id: number; rarity: ToyRarity };
};

function parseUnits(input: string, decimals: number): bigint {
  const trimmed = input.trim();
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === '' || trimmed === '.') return 0n;
  const [int, frac = ''] = trimmed.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(int || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
}

function friendlyBetError(e: unknown, symbol: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  const m = raw.match(/Max bet right now: ([\d.]+)/);
  if (m) return `Max bet right now: ${m[1]} ${symbol}`;
  if (/BetRiskExceedsLimit|ReservedProfit|reserved profit/i.test(raw)) return "The house can't cover a bet that size right now, go smaller.";
  if (/user rejected|UserRejected|denied/i.test(raw)) return 'Cancelled.';
  if (raw.length > 90) return 'Bet failed, try again.';
  return raw;
}

function formatUnits(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const int = value / base;
  const frac = (value % base).toString().padStart(decimals, '0').slice(0, 2);
  return `${int}.${frac}`;
}

export default function App() {
  const { hostApi, snapshot, mode } = useCasinoHost();
  const demo = mode === 'demo';

  // Host theme. VISUAL_AND_UX.md asks a polished guest to respect `ui.theme`
  // and `ui.locale` where practical. We comply inside the host iframe; the
  // standalone page (jam gallery, judges, shared wheel links) always keeps
  // the light carnival identity, so the brand reads identically everywhere
  // it is opened directly. `?theme=dark|light` forces a variant for testing.
  useEffect(() => {
    const root = document.documentElement;
    const forced = new URLSearchParams(window.location.search).get('theme');
    if (forced === 'dark' || forced === 'light') {
      root.dataset.theme = forced;
      return;
    }

    const hostTheme = snapshot?.ui?.theme;
    if (mode !== 'host' || !hostTheme) {
      root.dataset.theme = 'light';
      return;
    }
    if (hostTheme === 'dark' || hostTheme === 'light') {
      root.dataset.theme = hostTheme;
      return;
    }

    // 'system' → follow the OS preference and keep following it live
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { root.dataset.theme = mq.matches ? 'dark' : 'light'; };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [mode, snapshot?.ui?.theme]);

  const [paint, setPaint] = useState<Paint>(() => {
    // restore a shared/last-used wheel from the URL (?wheel=…), else last local paint
    try {
      const fromUrl = paintFromUrlParam(new URLSearchParams(window.location.search).get('wheel'));
      if (fromUrl) return fromUrl;
      const saved = localStorage.getItem('fg_paint_v1');
      if (saved) {
        const p = decodeGameData(saved as never);
        if (p) return p;
      }
    } catch { /* ignore */ }
    return defaultPaint();
  });
  const [paintTier, setPaintTier] = useState<Tier>(2);
  const [betInput, setBetInput] = useState('1');
  const [round, setRound] = useState<Round | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [spinNonce, setSpinNonce] = useState(0);
  const [pendingSegment, setPendingSegment] = useState<number | null>(null);
  const [collection, setCollection] = useState<Collection>(() => loadCollection());
  // which screen is showing. Starts on the table, because that is the game.
  const [tab, setTab] = useState<ScreenId>('play');
  // refusal note for a paint that would break the wheel's legality rule
  const [paintNote, setPaintNote] = useState<string | null>(null);
  const paintNoteTimer = useRef(0);
  // the first-session checklist: paint, spin, collect, then it retires for good
  const [painted, setPainted] = useState(false);
  const [firstLoopDone, setFirstLoopDone] = useState(() => {
    try { return localStorage.getItem('fg_first_loop_v1') === '1'; } catch { return false; }
  });
  // the table readout beside the LCD: the last few settled spins
  const [history, setHistory] = useState<{ tier: number; won: boolean; x: string }[]>([]);
  // today's objectives, the run of banked days, and the ladder they climb
  const [dayState, setDayState] = useState<DailyState>(() => loadDaily(dayKey()));
  const [ladder, setLadder] = useState<LadderState>(() => loadLadder());
  const missions = useMemo(() => dailyMissions(dayState.dayKey), [dayState.dayKey]);
  const [prizeToast, setPrizeToast] = useState<{ id: number; rarity: ToyRarity; fresh: boolean } | null>(null);
  const [muted, setMuted] = useState(() => { sfx.initSound(); return sfx.isMuted(); });
  const [balance, setBalance] = useState(DEMO_BALANCE_START);
  const [lcd, setLcd] = useState('FAIRGROUND v1.0');
  const [stats, setStats] = useState<Stats>(() => loadStats());
  // The "how to play" modal. Open on a first visit, dismissible, and reopenable
  // at any time from the header "?" button, so newcomers get walked through the
  // loop while returning players keep a clean booth.
  const [howOpen, setHowOpen] = useState(() => {
    try { return localStorage.getItem('fg_hint_done') !== '1'; } catch { return false; }
  });
  const [confetti, setConfetti] = useState(0); // increments to fire the legendary burst
  const [copied, setCopied] = useState(false);
  const [nearMiss, setNearMiss] = useState(false); // landed adjacent to risky
  const [err, setErr] = useState('');
  const roundRef = useRef<Round | null>(null);
  const placingRef = useRef(false); // guards double-tap double-bet
  roundRef.current = round;
  // Late-bound settle. `spinDemo` is memoised, and on the very first render the
  // bridge is still 'pending' so its captured `settle` closes over demo=false:
  // the opening spin after a reload would then skip the demo bank update and
  // reuse a stale collection. Routing every resolve through this ref means the
  // landing always runs against the newest render's state.
  const settleRef = useRef<(segment: number, outcome: ReturnType<typeof outcomeFromRandomness>) => void>(() => {});
  settleRef.current = settle;

  const decimals = demo ? 6 : snapshot?.token?.decimals ?? 6;
  const symbol = demo ? 'chUSD' : snapshot?.token?.symbol ?? 'chUSD';

  const walletReady = demo || snapshot?.wallet?.status === 'ready';
  const walletIssue = !demo && snapshot && snapshot.wallet.status !== 'ready' ? snapshot.wallet.status : null;
  const walletMessage =
    walletIssue === 'setup-required' ? 'Set up your smart vault in the host menu, then come back to play for real.' :
    walletIssue === 'disconnected' ? 'Connect your wallet in the host menu to play for real.' :
    walletIssue === 'session-key-mismatch' ? 'Session expired, reconnect in the host menu.' :
    walletIssue ? 'Wallet not ready, open the host menu.' : null;
  const rawBalance = demo ? balance : BigInt(snapshot?.balances?.smartVaultBalance ?? '0');

  // max wager from live platform limits (heaviest legal paint ≈ 12.37×)
  const maxWager = useMemo(() => {
    if (demo) return balance;
    const cap = computeMaxWager(snapshot, { maxMultiplierX: 12.37 });
    if (cap === undefined) return 1000n * 10n ** BigInt(decimals);
    return cap;
  }, [demo, snapshot, balance, decimals]);

  const prices = priceWheel(paint);
  const legal = isLegalPaint(paint);
  const counts = tierCounts(paint);
  const riskyCount = Number(counts[2]);
  const midCount = Number(counts[1]);
  const safeCount = Number(counts[0]);
  const activePreset = presetOf(paint);
  // a risky win gets the heavy landing shake; the wheel reads the last result
  const heavyShake = !!result && result.won && result.tier === 2;

  // LCD: idle → RTP + max mult; spinning → status; done → result
  useEffect(() => {
    if (round) setLcd(round.sessionId ? 'SPINNING... GOOD LUCK' : 'SENDING BET...');
    else if (result) setLcd(result.won ? `WIN ${formatUnits(result.payout, decimals)} ${symbol}` : 'NO WIN - REPAINT?');
    else setLcd(`RTP 96.00  MAX ${formatMultiplier(prices.risky)}`);
  }, [round, result, prices.risky, decimals, symbol]);

  // host-driven settle: find our session row, decode gameState
  useEffect(() => {
    if (demo || !snapshot || !round || !round.sessionKey) return;
    const row = snapshot.sessions.items.find(s => s.sessionKey === round.sessionKey);
    if (!row || !isTerminal(row.phase)) return;
    if (row.phase === PHASE_CANCELLED || row.phase === PHASE_FORFEITED) {
      // A cancel or forfeit moves balance back to the player, and the host
      // keeps that credit withheld until we reveal. Harmless no-op if the
      // host has nothing held for this session.
      void hostApi?.revealOutcome({ sessionId: row.sessionId }).catch(() => {});
      setRound(null);
      setPendingSegment(null);
      setLcd('ROUND CANCELLED');
      return;
    }
    // Prefer the authoritative randomness word; fall back to gameState decode.
    const rand = row.raw?.randomness;
    const rnd = rand ?? null;
    if (rnd) {
      const outcome = outcomeFromRandomness(round.wager, round.paint, rnd);
      // animate the wheel to the landed segment, then resolve on land
      setPendingSegment(outcome.segment);
      setSpinNonce(n => n + 1);
      pendingResolveRef.current = () => {
        settleRef.current(outcome.segment, outcome);
        // The host holds the win back from its balance display until the
        // result has been shown, and it tracks the round by the bare
        // `sessionId`. `sessionKey` is "{chainId}:{sessionId}", so passing it
        // here matches no tracked round and the balance never credits while
        // the game is open. The row is the authoritative source for both.
        void hostApi?.revealOutcome({ sessionId: row.sessionId }).catch(() => {});
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, round, demo]);

  // session resume: a reload mid-VRF-wait recovers the in-flight round from
  // the host's snapshot, and the wheel animates to its segment when VRF lands.
  useEffect(() => {
    if (demo || !snapshot || round) return;
    const row = snapshot.sessions.items.find(
      s => s.gameAddress === snapshot.integration.gameAddress && !s.isSettled && s.phase === PHASE_WAITING_RANDOMNESS,
    );
    if (!row) return;
    const resumedPaint = row.raw?.gameData ? decodeGameData(row.raw.gameData) : null;
    const wager = BigInt(row.stake ?? row.wager ?? '0');
    if (!resumedPaint || wager <= 0n) return;
    setPaint(resumedPaint);
    setRound({ wager, paint: resumedPaint, sessionKey: row.sessionKey, sessionId: row.sessionId, pending: false });
    setLcd('RESUMED - WAITING FOR VRF...');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, round, demo]);

  function settle(segment: number, outcome: ReturnType<typeof outcomeFromRandomness>) {
    const r = roundRef.current;
    if (!r) return;
    const won = outcome.payout > 0n;
    setResult({ segment, tier: outcome.tier, payout: outcome.payout, won, prize: outcome.prize });
    setRound(null);
    setPendingSegment(null);
    sfx.land();
    // a risky win lands harder: short taps on a plain land, a small pattern on a win
    buzz(won && outcome.tier === 2 ? [18, 40, 90] : 12);
    window.setTimeout(() => sfx.sting(outcome.tier, won, outcome.multiplierWad >= 4n), 140);

    // near-miss drama: a losing spin that stopped directly NEXT to a risky wedge
    const adjacent = [segment - 1 < 0 ? paint.tiers.length - 1 : segment - 1, (segment + 1) % paint.tiers.length];
    if (!won && adjacent.some(i => r.paint.tiers[i] === 2)) {
      setNearMiss(true);
      window.setTimeout(() => sfx.nearMiss(), 620);
      window.setTimeout(() => setNearMiss(false), 2400);
    }

    // hot-streak riser on consecutive wins (after the tier sting)
    if (won) {
      const nextStreak = stats.streak + 1;
      if (nextStreak >= 2) window.setTimeout(() => sfx.streakRiser(nextStreak), 420);
    }

    // demo balance bookkeeping
    if (demo) {
      setBalance(b => (b - r.wager + outcome.payout));
    }

    // daily objectives (cosmetic only, see lib/missions.ts)
    recordMission('spins');
    setHistory(prev => [
      { tier: outcome.tier, won, x: formatMultiplier(outcome.multiplierWad) },
      ...prev,
    ].slice(0, 8));
    if (won) recordMission('wins');
    if (outcome.tier === 2) recordMission('riskyLands');
    if (won && outcome.tier === 2) recordMission('riskyWins');
    if (outcome.prize.rarity === 'legendary') recordMission('legendaryPrizes');
    // a bold paint is one with risky covering at least 40% of the wheel, so
    // the objective asks the player to actually shape the paytable
    const landedCounts = tierCounts(r.paint);
    if (landedCounts[2] * 5n >= BigInt(r.paint.segmentCount) * 2n) recordMission('boldSpins');

    // session stats, streaks, milestones (cosmetic, client-only)
    const winAmount = formatUnits(outcome.payout, decimals);
    const bigWin = outcome.tier === 2 || outcome.prize.rarity === 'legendary';
    if (bigWin) setConfetti(c => c + 1);
    setStats(prev => {
      const today = dayKey();
      const next: Stats = {
        spins: prev.spins + 1,
        streak: won ? prev.streak + 1 : 0,
        bestWin: won && parseFloat(winAmount) > parseFloat(prev.bestWin) ? winAmount : prev.bestWin,
        milestones: prev.milestones,
        lastPlayDay: today,
        dailyStreak: prev.lastPlayDay === today ? prev.dailyStreak : prev.dailyStreak + 1,
      };
      const celebrate = (id: string, label: string) => {
        if (next.milestones.includes(id)) return;
        next.milestones = [...next.milestones, id];
        window.setTimeout(() => { setLcd(`★ ${label} ★`); sfx.fanfare(); }, 1900);
      };
      if (next.spins === 10) celebrate('spins10', '10 SPINS');
      if (next.spins === 50) celebrate('spins50', '50 SPINS');
      if (outcome.prize.rarity === 'rare') celebrate('firstRare', 'FIRST RARE PRIZE');
      if (outcome.prize.rarity === 'legendary') celebrate('firstLegendary', 'FIRST LEGENDARY!');
      if (next.streak >= 5) celebrate(`streak${next.streak}`, `${next.streak} WIN STREAK`);
      saveStats(next);
      return next;
    });

    // prize collection, and the album stamps a set the day it is finished
    const { next, isNew } = addToCollection(collection, outcome.prize.id, outcome.prize.rarity);
    let updated = next;
    const before = unlockedLiveries(collection);
    const after = unlockedLiveries(next);
    const newUnlock = [...after].find(l => !before.has(l));
    if (newUnlock) {
      const set = SETS.find(s => s.rewardLivery === newUnlock);
      if (set) updated = withStamp(updated, set.id, dayKey());
      recordMission('setsCompleted');
    }
    if (albumProgress(updated).complete) updated = withStamp(updated, 'album', dayKey());
    setCollection(updated);
    saveCollection(updated);
    setPrizeToast({ id: outcome.prize.id, rarity: outcome.prize.rarity, fresh: isNew });
    window.setTimeout(() => setPrizeToast(null), 2600);
    if (newUnlock) {
      window.setTimeout(() => { sfx.fanfare(); setCollection(c => ({ ...c, activeLivery: newUnlock })); saveCollection({ ...updated, activeLivery: newUnlock }); }, 900);
    } else {
      window.setTimeout(() => sfx.prize(0), 500);
    }
  }

  const pendingResolveRef = useRef<(() => void) | null>(null);

  // The round is passed in rather than read back from the ref: this runs on a
  // timer, and if React has not committed the setRound yet the ref is still
  // null, which used to leave the booth on SPINNING… with SPIN disabled forever.
  const spinDemo = useCallback((r: Round) => {
    const seed = demoSeed();
    const rnd = demoRandomness(seed);
    const outcome = outcomeFromRandomness(r.wager, r.paint, rnd);
    setPendingSegment(outcome.segment);
    setSpinNonce(n => n + 1);
    // landing callback resolves the round
    pendingResolveRef.current = () => settleRef.current(outcome.segment, outcome);
  }, []);

  const onWheelLand = useCallback(() => {
    const resolve = pendingResolveRef.current;
    pendingResolveRef.current = null;
    resolve?.();
  }, []);

  async function placeBet() {
    setErr('');
    if (placingRef.current || round) return; // placingRef: two rapid taps must not open two sessions
    placingRef.current = true;
    try {
      if (!legal) { setErr('Paint needs all three tiers (risky ≤ half the wheel).'); return; }
      const wager = parseUnits(betInput, decimals);
      if (wager <= 0n) { setErr('Enter a bet amount.'); return; }
      if (wager > maxWager) { setErr(`Max bet right now: ${formatUnits(maxWager, decimals)} ${symbol}`); return; }
      if (demo && wager > balance) { setErr('Not enough demo balance.'); return; }

      // the player is betting now: get the instructions out of the way
      if (howOpen) dismissHow();

      const gameData = encodeGameData(paint);

      const rt: Round = { wager, paint, pending: true };
      setRound(rt);
      setResult(null);
      // hand the round to the land callback straight away: the timer below can
      // otherwise fire before React has committed the state
      roundRef.current = rt;

      if (demo || !hostApi) {
        // let React paint the disabled button first
        window.setTimeout(() => spinDemo(rt), 60);
        // A demo spin resolves on its own animation frame, so nothing should
        // ever leave the round open. If it does (a dropped frame, a tab
        // backgrounded mid-spin), free the booth rather than wedge SPIN.
        window.setTimeout(() => {
          if (roundRef.current !== rt) return;
          setRound(null);
          setPendingSegment(null);
          setErr('That spin stalled. Tap SPIN again.');
        }, 9000);
        return;
      }

      try {
        const { sessionKey } = await hostApi.openSession({ wager: wager.toString(), gameData });
        if (roundRef.current === rt) {
          setRound({ ...rt, sessionKey, pending: false });
          setLcd('WAITING FOR VRF...');
        }
      } catch (e) {
        setRound(null);
        setErr(friendlyBetError(e, symbol));
      }
    } finally {
      placingRef.current = false;
    }
  }

  function refusePaint(note: string) {
    sfx.deny();
    setPaintNote(note);
    window.clearTimeout(paintNoteTimer.current);
    paintNoteTimer.current = window.setTimeout(() => setPaintNote(null), 2400);
  }

  function paintSegment(i: number) {
    if (round) return;
    const tiers = [...paint.tiers];
    tiers[i] = paintTier;
    const np = { ...paint, tiers };
    if (!isLegalPaint(np)) {
      // legal means at least one risky slice, at least one cushion, and never
      // more than half the wheel risky. Say so instead of eating the tap.
      const counts = tierCounts(paint);
      refusePaint(counts[2] * 2n >= BigInt(paint.segmentCount)
        ? 'Risky can be at most half the wheel. Paint a risky slice back to Mid or Safe first.'
        : 'The wheel needs at least one Risky slice and one Safe or Mid slice.');
      return;
    }
    sfx.click();
    setPaint(np);
    setPainted(true);
    if (paintNote) setPaintNote(null);
  }

  function applyPreset(id: PaintPresetId) {
    if (round) return;
    sfx.click();
    setPaint(presetPaint(paint.segmentCount, id));
    setPainted(true);
    if (paintNote) setPaintNote(null);
  }

  function cycleSegmentCount() {
    if (round) return;
    sfx.click();
    setPaint(p => {
      const sizes = [8, 10, 12, 14, 16];
      const nextSize = sizes[(sizes.indexOf(p.segmentCount) + 1) % sizes.length];
      const tiers: Tier[] = Array.from({ length: nextSize }, (_, i) => p.tiers[i % p.tiers.length]);
      const np = { segmentCount: nextSize, tiers };
      return isLegalPaint(np) ? np : p;
    });
  }

  function autoRepaint() {
    if (round) return;
    sfx.click();
    // random legal paint
    for (let tries = 0; tries < 200; tries++) {
      const tiers: Tier[] = Array.from({ length: paint.segmentCount }, () => Math.floor(Math.random() * 3) as Tier);
      const np = { ...paint, tiers };
      if (isLegalPaint(np)) { setPaint(np); return; }
    }
  }

  // persist the paint locally + mirror it into the URL as a shareable wheel
  useEffect(() => {
    try {
      localStorage.setItem('fg_paint_v1', encodeGameData(paint));
      const u = new URL(window.location.href);
      u.searchParams.set('wheel', paintToUrlParam(paint));
      window.history.replaceState(null, '', u);
    } catch { /* ignore */ }
  }, [paint]);

  function dismissHow() {
    setHowOpen(false);
    try { localStorage.setItem('fg_hint_done', '1'); } catch { /* ignore */ }
  }

  // ── daily missions ──────────────────────────────────────────────────────
  // Progress is recorded from gameplay and banked as soon as all three
  // objectives are met. Everything awarded here is cosmetic; no reward path
  // touches a wager, a multiplier or an outcome.
  function recordMission(metric: Metric, amount = 1) {
    setDayState(prev => recordMetric(rollDaily(prev, dayKey()), metric, amount));
  }

  useEffect(() => { saveDaily(dayState); }, [dayState]);
  useEffect(() => { saveLadder(ladder); }, [ladder]);

  useEffect(() => {
    if (dayState.dayComplete) return;
    if (!allMissionsDone(missions, dayState)) return;
    const banked = completeDay(dayState, ladder, missions, dayState.dayKey);
    if (!banked.awarded) return;
    setDayState(banked.daily);
    setLadder(banked.ladder);
    window.setTimeout(() => {
      setLcd(`★ DAY ${banked.ladder.day} · ${banked.awarded!.label.toUpperCase()} ★`);
      sfx.fanfare();
    }, 700);
    if (banked.awarded.kind === 'wheel') {
      const withPrize = withTrophy(collection, banked.awarded.id);
      setCollection(withPrize);
      saveCollection(withPrize);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayState, missions, ladder, collection]);

  // The instructions are a centered modal now, so they stay until the player
  // closes them: no timer racing a slow reader. Escape closes, and the page
  // behind the backdrop is held still while it is open.
  useEffect(() => {
    if (!howOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      dismissHow();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [howOpen]);

  // switching screens lands at the top, the way a new page would
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [tab]);

  function shareWheel() {
    try { void navigator.clipboard.writeText(window.location.href); } catch { /* ignore */ }
    setCopied(true);
    recordMission('shareCopied');
    window.setTimeout(() => setCopied(false), 1500);
  }

  const wagerPreview = (() => {
    const w = parseUnits(betInput, decimals);
    if (w <= 0n) return null;
    const riskyWin = (w * prices.risky) / 10n ** 18n; // prices are WAD-scaled
    return `${formatUnits(w, decimals)} → up to ${formatUnits(riskyWin, decimals)} ${symbol} on risky`;
  })();

  const liveryUnlocked = unlockedLiveries(collection);
  const shelf = shelfStats(collection);
  const album = albumProgress(collection);
  // every part of the loop has been played at least once
  const firstLoopComplete = painted && stats.spins > 0 && shelf.owned > 0;

  // The first-session checklist retires itself once the loop has been played.
  // It stays up for a beat after the third tick so the player sees it complete.
  useEffect(() => {
    if (firstLoopDone || !firstLoopComplete) return;
    const t = window.setTimeout(() => {
      setFirstLoopDone(true);
      try { localStorage.setItem('fg_first_loop_v1', '1'); } catch { /* private mode */ }
      setLcd('★ FIRST LOOP DONE ★');
      sfx.fanfare();
    }, 1800);
    return () => window.clearTimeout(t);
  }, [firstLoopDone, firstLoopComplete]);
  const doneToday = missions.filter(m => missionProgress(m, dayState).done).length;

  if (mode === 'pending') {
    return (
      <div className="boot">
        <div>
          <BootWheel />
          <p>ENTERING THE FAIRGROUND…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      {demo && !CLEAN_MODE && (
        <div className="overlay-badge" title="Free-play demo · the real game runs inside chain.wtf with your vault balance">
          <span className="tick-dot" />
          DEMO TICKET · FREE PLAY
        </div>
      )}

      <header className="top">
        <div className="brand">
          <div className="brand-mark"><WheelBadge /></div>
          <div>
            <div className="brand-name">FAIRGROUND</div>
            <div className="brand-sub">the honest carnival</div>
          </div>
        </div>
        <div className="chips">
          <div className="chip lcd"><span className="lbl">LCD</span><span>{lcd}</span></div>
          <div className="chip"><span className="lbl">Bank</span>{formatUnits(rawBalance, decimals)} {symbol}</div>
          <button className="icon-btn" onClick={() => { sfx.click(); setHowOpen(true); }} aria-label="how to play" title="How to play">
            ?
          </button>
          <button className="icon-btn" onClick={() => setMuted(sfx.toggleMute())} aria-label="toggle sound">
            {muted ? '🔇' : '🔊'}
          </button>
        </div>
      </header>

      {/* One nav for both layouts: a segmented control under the header on
          desktop, a fixed bottom bar on phones. The badges are the reason to
          visit the other two screens, so they carry live progress. */}
      <nav className="tabnav" role="tablist" aria-label="screens">
        {SCREENS.map(s => (
          <button
            key={s.id}
            type="button"
            role="tab"
            id={`tab-${s.id}`}
            aria-selected={tab === s.id}
            aria-controls={`screen-${s.id}`}
            className={`tab${tab === s.id ? ' on' : ''}`}
            onClick={() => { sfx.click(); setTab(s.id); }}
          >
            <span className="t-icon" aria-hidden="true">{s.icon}</span>
            <span className="t-label">{s.label}</span>
            <span className="t-badge">
              {s.id === 'collect' ? `${shelf.owned}/${shelf.total}` : s.id === 'daily' ? `${doneToday}/3` : 'READY'}
            </span>
          </button>
        ))}
      </nav>

      <main className="screens">
      <section
        className="screen stage"
        id="screen-play"
        role="tabpanel"
        aria-labelledby="tab-play"
        hidden={tab !== 'play'}
      >
        <section className={`panel${paintNote ? ' nope' : ''}`}>
          <div className="panel-title">
            <h2>The paytable is yours · paint, then spin</h2>
            <span className="hint">tap a slice to paint · {paint.segmentCount} slices</span>
          </div>

          <Wheel
            paint={paint}
            onPaintSegment={paintSegment}
            spinNonce={spinNonce}
            resultSegment={pendingSegment}
            livery={collection.activeLivery}
            interactive={!round}
            onTickSound={(s01) => sfx.tick(s01)}
            onLand={onWheelLand}
            heavyShake={heavyShake}
          />

          <div className="tier-row">
            {([0, 1, 2] as Tier[]).map(t => (
              <button
                key={t}
                className={`tier-pill ${t === 0 ? 'safe' : t === 1 ? 'mid' : 'risky'}${paintTier === t ? ' selected' : ''}`}
                onClick={() => { sfx.click(); setPaintTier(t); }}
              >
                <span className="dot" />
                {t === 0 ? 'Safe' : t === 1 ? 'Mid' : 'Risky'}
                <span className="mult">{formatMultiplier(t === 0 ? prices.safe : t === 1 ? prices.mid : prices.risky)}</span>
              </button>
            ))}
          </div>

          {/* Fast starts: a legal, meaningful paint in one tap, so nobody has
              to learn a rule before they can play well. */}
          <div className="paint-presets" role="group" aria-label="ready-made paints">
            <span className="pp-label">Stake shape</span>
            {PAINT_PRESETS.map(p => (
              <button
                key={p.id}
                type="button"
                title={p.hint}
                disabled={!!round}
                className={`preset${activePreset === p.id ? ' on' : ''}`}
                onClick={() => applyPreset(p.id)}
              >
                {p.label}
              </button>
            ))}
            <span className="pp-state">{activePreset ? '' : 'custom'}</span>
          </div>

          {/* The trade, made visible: as risky takes more of the wheel, each
              risky slice pays less. This is the whole game in one line. */}
          <div className="paint-readout">
            <span><b>{riskyCount}</b> of {paint.segmentCount} risky</span>
            <span>risky pays <b>{formatMultiplier(prices.risky)}</b></span>
            <span>mid <b>{formatMultiplier(prices.mid)}</b></span>
            <span className="stamp">RTP 96.00%</span>
          </div>

          {paintNote && (
            <div className="paint-note" role="status">{paintNote}</div>
          )}

          <details className="fair-deets">
            <summary>Why this stays fair</summary>
            <ul>
              <li>
                You set the prices. Take more of the wheel risky and each risky slice pays
                less: the return stays fixed, so no paint is better than another.
              </li>
              <li>
                Safe {safeCount} pays {formatMultiplier(prices.safe)} · Mid {midCount} pays{' '}
                {formatMultiplier(prices.mid)} · Risky {riskyCount} pays {formatMultiplier(prices.risky)}
              </li>
              <li>Expected return is 96.00% on every legal paint, by construction, not on average.</li>
              <li>One VRF word per spin, rejection-sampled, so every slice is exactly as likely as every other.</li>
              <li>
                <a href="https://github.com/thesithunyein/fairground/blob/main/docs/MATH.md" target="_blank" rel="noreferrer">
                  The declared maths and the verifier that proves it
                </a>{' '}
                · <code>npm run verify:rtp</code>
              </li>
            </ul>
          </details>

          {stats.spins > 0 && (
            <div className="stats-strip">
              <span><b>{stats.spins}</b> spins</span>
              <span className={stats.streak >= 3 ? 'hot' : ''}><b>{stats.streak}</b> streak</span>
              <span>best <b>{stats.bestWin}</b></span>
              <span>day <b>{stats.dailyStreak}</b> 🔥</span>
            </div>
          )}
        </section>

        <section className="controls">
          <div className="lcd-panel">
            <div className={result?.won ? 'lcd-win' : 'lcd-main'}>
              {round ? '● SPINNING' : result ? (result.won ? `▲ ${formatUnits(result.payout, decimals)} ${symbol}` : '▼ NO WIN') : '■ PLACE YOUR BET'}
            </div>
            <button className="icon-btn" style={{ boxShadow: 'none', background: '#2a2d2b', borderColor: '#2a2d2b', color: '#7dffb2' }} onClick={autoRepaint} title="random legal paint">🎲</button>
          </div>

          {/* the last few spins beside the LCD: the table readout a player
              expects, and a reminder that you can paint and go again */}
          <div className="recent" aria-label="recent spins">
            <span className="r-lbl">LAST</span>
            {history.length === 0
              ? <span className="r-empty">no spins yet</span>
              : history.map((h, i) => (
                <span key={i} className={`r-chip t${h.tier}${h.won ? ' win' : ''}`}>{h.x}</span>
              ))}
          </div>

          <div className="panel bet-block">
            <div className="row">
              <button className="half-double" onClick={() => { sfx.click(); setBetInput(v => formatUnits(parseUnits(v, decimals) / 2n, decimals)); }}>½</button>
              <div className="bet-input-wrap">
                <input
                  inputMode="decimal"
                  value={betInput}
                  onChange={e => setBetInput(e.target.value.replace(/[^0-9.]/g, ''))}
                  disabled={!!round}
                  aria-label="bet amount"
                />
                <span className="unit">{symbol}</span>
              </div>
              <button className="half-double" onClick={() => { sfx.click(); setBetInput(v => { const d = parseUnits(v, decimals) * 2n; return formatUnits(d > maxWager ? maxWager : d, decimals); }); }}>2×</button>
            </div>
            <div className="bet-meta">
              <span>{wagerPreview ?? `max ${formatUnits(maxWager, decimals)}`}</span>
              <button
                className="mini-link"
                style={{ border: 'none', background: 'none', color: 'var(--blue-deep)', fontWeight: 900, cursor: 'pointer', fontSize: 11 }}
                onClick={shareWheel}
              >
                {copied ? 'LINK COPIED ✓' : 'COPY WHEEL LINK'}
              </button>
              <button
                className="mini-link"
                style={{ border: 'none', background: 'none', color: 'var(--blue-deep)', fontWeight: 900, cursor: 'pointer', fontSize: 11 }}
                onClick={cycleSegmentCount}
              >
                {paint.segmentCount} slices
              </button>
            </div>
          </div>

          <button
            className={`spin-btn${!round && walletReady ? ' attract' : ''}`}
            disabled={!!round || !walletReady}
            onClick={placeBet}
          >
            {round ? (round.sessionId || demo ? 'SPINNING…' : 'SIGNING…') : walletReady ? 'SPIN' : walletIssue === 'disconnected' ? 'CONNECT WALLET' : 'WALLET NOT READY'}
          </button>

          {walletMessage && !err && (
            <div className="wallet-note" role="status">{walletMessage}</div>
          )}

          {err && (
            <div className="result-banner lose" role="alert">{err}</div>
          )}

          {result && !round && (
            <div className={`result-banner ${result.won ? 'win' : nearMiss ? 'lose near' : 'lose'}`}>
              {result.won
                ? <span>WIN <CountUpTo value={parseFloat(formatUnits(result.payout, decimals))} /> {symbol} · {result.tier === 2 ? 'RISKY' : result.tier === 1 ? 'MID' : 'SAFE'} paid</span>
                : <span>{nearMiss ? 'SO CLOSE · landed next to risky. ' : `No win · landed ${result.tier === 2 ? 'risky' : result.tier === 1 ? 'mid' : 'safe'}. `}Repaint and go again.</span>
            }            </div>
          )}

          {/* First-session guidance: three ticks and it retires for good, so a
              newcomer always knows what to do next without reading anything. */}
          {!firstLoopDone && (
            <div className="first-loop">
              <span className="fl-title">First loop</span>
              <span className={`fl-step${painted ? ' done' : ''}`}>{painted ? '✓' : '1'} Paint a slice</span>
              <span className={`fl-step${stats.spins > 0 ? ' done' : ''}`}>{stats.spins > 0 ? '✓' : '2'} Spin</span>
              <span className={`fl-step${shelf.owned > 0 ? ' done' : ''}`}>{shelf.owned > 0 ? '✓' : '3'} Collect a prize</span>
            </div>
          )}

          {/* A preview of the album, one tap from the full page. The prizes
              drop while you spin, so this is where the fresh-prize pulse is
              seen; the album itself lives on the COLLECT screen. */}
          <button className="shelf-jump" type="button" onClick={() => { sfx.click(); setTab('collect'); }}>
            <span className="sj-head">
              <span className="sj-label">Your shelf</span>
              <span className="sj-go">{shelf.owned}/{shelf.total} · ALBUM ›</span>
            </span>
            <span className="shelf-row compact">
              {[0, 1, 2, 3, 4, 5].map(toy => (
                <ShelfCell key={toy} toy={toy} collection={collection} fresh={prizeToast?.fresh && prizeToast.id === toy} />
              ))}
            </span>
          </button>
        </section>
      </section>

      {/* COLLECT: the whole album, every prize grouped into its set, each set
          naming the livery it pays out, plus the season stamp when all three
          are done. Progress is cosmetic and provably cannot move the odds. */}
      <section
        className="screen collect"
        id="screen-collect"
        role="tabpanel"
        aria-labelledby="tab-collect"
        hidden={tab !== 'collect'}
      >
        <div className="panel">
          <div className="panel-title">
            <h2>Prize Album · Season 1</h2>
            <span className="album-open">
              {album.have}/{album.total} collected
            </span>
          </div>

          <div className="season-bar"><i style={{ width: `${(album.have / album.total) * 100}%` }} /></div>

          <p className="screen-lead">
            Every spin drops a carnival prize. Fill all six of a set and the booth unlocks
            its livery. Collecting never touches the odds: RTP stays 96% every spin.
          </p>

          {album.sets.map(({ set, have, total, done }) => (
            <div key={set.id} className="album-set">
              <div className="album-set-head">
                <b>{set.label}</b>
                <span>{done ? `complete · ${set.rewardLabel} unlocked` : `${have}/${total} · unlocks the ${set.rewardLabel}`}</span>
              </div>
              <div className="shelf-row">
                {TOY_NAMES.map((name, toy) => {
                  const key = `${name}:${set.rarity}`;
                  const count = collection.counts[key] ?? 0;
                  return (
                    <div key={key} className={`prize-cell ${set.rarity}${count > 0 ? ' owned' : ''}`}>
                      {count > 0
                        ? <PrizeSprite toy={toy} rarity={set.rarity} size={38} />
                        : <span style={{ opacity: 0.25, fontSize: 15 }}>?</span>}
                      {count > 1 && <span className="count">{count}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="livery-row">
            {LIVERIES.map(l => {
              const unlocked = liveryUnlocked.has(l.id);
              const active = collection.activeLivery === l.id;
              return (
                <button
                  key={l.id}
                  className={`livery-dot ${l.id}${active ? ' active' : ''}${unlocked ? '' : ' locked'}`}
                  title={unlocked ? l.label : `${l.label}: ${l.unlockHint}`}
                  onClick={() => { if (unlocked) { sfx.click(); const c = { ...collection, activeLivery: l.id }; setCollection(c); saveCollection(c); } }}
                >
                  {unlocked ? '' : '🔒'}
                </button>
              );
            })}
          </div>

          <div className="shelf-progress">
            <span>
              {album.complete && collection.stamps.album
                ? `season sealed · ${formatStamp(collection.stamps.album)}`
                : 'wheel colours change with every complete set'}
            </span>
            <span className="stamp">96% RTP always</span>
          </div>
        </div>
      </section>

      {/* DAILY: three objectives that rotate at midnight UTC, and the seven rung
          ladder they feed. Stamps and one wheel skin, never a payout. */}
      <section
        className="screen daily"
        id="screen-daily"
        role="tabpanel"
        aria-labelledby="tab-daily"
        hidden={tab !== 'daily'}
      >
        <div className="panel">
          <div className="panel-title">
            <h2>Daily Booth</h2>
            <span className="hint">{doneToday}/3 today · day {ladder.day || 1}</span>
          </div>

          <p className="screen-lead">
            Three objectives, fresh at midnight UTC. Bank all three and the run climbs a
            rung: seven days in a row earns the gilded wheel. Stamps are cosmetic, so
            none of this can change a wager, a multiplier or a payout.
          </p>

          <div className="mission-list">
            {missions.map(m => {
              const p = missionProgress(m, dayState);
              return (
                <div key={m.id} className={`mission${p.done ? ' done' : ''}`}>
                  <span className="m-tick">{p.done ? '✓' : ''}</span>
                  <span className="m-label">{m.label}</span>
                  <span className="m-count">{Math.min(p.have, p.target)}/{p.target}</span>
                  <span className="m-bar"><i style={{ width: `${Math.min(100, (p.have / p.target) * 100)}%` }} /></span>
                </div>
              );
            })}
          </div>

          <div className="ladder">
            {LADDER.map(r => (
              <span
                key={r.id}
                className={`rung${ladder.badges.includes(r.id) ? ' earned' : ''}${(ladder.day || 1) === r.day ? ' now' : ''}${r.kind === 'wheel' ? ' trophy' : ''}`}
                title={`Day ${r.day} · ${r.label}`}
              >
                {r.day}
              </span>
            ))}
          </div>

          <div className="shelf-progress">
            <span>{dayState.dayComplete ? 'today is banked · stamps are cosmetic' : 'bank all three to climb the ladder'}</span>
            <span className="stamp">{ladder.badges.length} stamps</span>
          </div>
        </div>
      </section>
      </main>

      <footer className="fair-note">
        <span>Provably fair: exactly-uniform wheel · VRF randomness · paytable recomputed on-chain from YOUR paint</span>
        <span className="stamp">DECLARED RTP 96% · HOUSE EDGE 4%</span>
      </footer>

      {/* How to play, centered over the booth. A newcomer should not have to
          scroll to find out what the game is, so this is a modal on arrival
          and from the header "?" button. Backdrop click and Escape close it. */}
      {howOpen && (
        <div className="howto-backdrop" onClick={dismissHow}>
          <div
            className="howto"
            role="dialog"
            aria-modal="true"
            aria-labelledby="howto-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="howto-head">
              <h3 id="howto-title">HOW TO PLAY</h3>
              <button className="howto-x" type="button" onClick={dismissHow} aria-label="close how to play" autoFocus>✕</button>
            </div>

            <div className="howto-steps">
              <div className="howto-step paint">
                <span className="howto-num">1</span>
                <span>
                  <b>PAINT A SLICE.</b> Pick a stake shape (Gentle, Standard or Wild) or tap any slice
                  to make it Safe, Mid or Risky. The multiplier on each slice moves with it, so you are
                  setting the paytable. The odds never change.
                </span>
              </div>
              <div className="howto-step spin">
                <span className="howto-num">2</span>
                <span>
                  <b>SPIN.</b> One VRF word picks the slice with rejection sampling, so every slice is exactly
                  as likely as every other one. Nobody can steer it, us included.
                </span>
              </div>
              <div className="howto-step collect">
                <span className="howto-num">3</span>
                <span>
                  <b>COLLECT.</b> Every spin also drops a carnival prize. Fill all six of a rarity to unlock a
                  new booth livery.
                </span>
              </div>
            </div>

            <div className="howto-foot">
              <b>RTP stays 96% for every legal paint.</b> Paint it gentle or paint it wild: the maths is
              identical every time. The declared maths and the verifier that proves it live in the repo.
            </div>

            <p className="howto-tabs">
              The tabs switch screens: <b>PLAY</b> is the table, <b>COLLECT</b> is your
              album of prizes, <b>DAILY</b> is today's objectives. Progress is saved in
              this browser.
            </p>

            <button className="howto-ok" type="button" onClick={dismissHow}>GOT IT</button>
          </div>
        </div>
      )}

      {confetti > 0 && <ConfettiBurst key={confetti} />}

      {prizeToast && (
        <div className={`prize-toast ${prizeToast.rarity}`}>
          <PrizeSprite toy={prizeToast.id} rarity={prizeToast.rarity} size={30} />
          <div>
            <div className="t-name">{prizeToast.fresh ? 'New prize!' : 'Prize again'} {['Duck', 'Rocket', 'Cat', 'Robot', 'Balloon', 'Heart'][prizeToast.id]}</div>
            <span className="t-rarity">{prizeToast.rarity}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** 2026-09-12 → 12 Sep 2026, for the album's completion stamp. */
function formatStamp(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (!y || !m || !d) return dayKey;
  return `${d} ${months[m - 1]} ${y}`;
}

/** Win amount ticks up like a scoreboard. */
export class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('FAIRGROUND crash:', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          minHeight: '100vh', display: 'grid', placeItems: 'center',
          background: '#f7f4ec', color: '#141414', fontFamily: 'monospace', textAlign: 'center', padding: 24,
        }}>
          <div>
            <div style={{ fontSize: 40 }}>🎪</div>
            <h1 style={{ fontSize: 18, letterSpacing: '0.12em' }}>THE BOOTH JAMMED</h1>
            <p style={{ fontSize: 12, opacity: 0.7, maxWidth: 320 }}>
              Something broke on this device. Reload, your prizes and stats are saved.
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{
                marginTop: 12, padding: '10px 22px', fontSize: 14, fontWeight: 900,
                background: '#2f6bff', color: '#fff', border: '2px solid #141414',
                borderRadius: 12, boxShadow: '3px 3px 0 #141414', cursor: 'pointer',
              }}
            >
              RELOAD THE FAIRGROUND
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function CountUpTo({ value }: { value: number }) {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const DUR = 650;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / DUR);
      setShown(value * (1 - Math.pow(1 - t, 3)));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{shown.toFixed(2)}</>;
}

function ConfettiBurst() {
  const pieces = useMemo(
    () => Array.from({ length: 90 }, (_, i) => ({
      left: Math.random() * 100,
      delay: Math.random() * 0.35,
      dur: 1.6 + Math.random() * 1.2,
      size: 6 + Math.random() * 8,
      color: ['#2f6bff', '#e8442e', '#f5b301', '#1d9e57', '#141414'][i % 5],
      rot: Math.random() * 360,
    })),
    [],
  );
  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((p, i) => (
        <i
          key={i}
          style={{
            left: `${p.left}%`,
            width: p.size,
            height: p.size * 0.6,
            background: p.color,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.dur}s`,
            transform: `rotate(${p.rot}deg)`,
          }}
        />
      ))}
    </div>
  );
}

function ShelfCell({ toy, collection, fresh }: { toy: number; collection: Collection; fresh?: boolean }) {
  const rarities: ToyRarity[] = ['legendary', 'rare', 'common'];
  const ownedRarity = rarities.find(r => (collection.counts[`${['duck','rocket','cat','robot','balloon','heart'][toy]}:${r}`] ?? 0) > 0);
  const count = ownedRarity ? collection.counts[`${['duck','rocket','cat','robot','balloon','heart'][toy]}:${ownedRarity}`] : 0;
  return (
    <div className={`prize-cell ${ownedRarity ?? ''} ${ownedRarity ? 'owned' : ''} ${fresh ? 'prize-fresh' : ''}`}>
      {ownedRarity ? <PrizeSprite toy={toy} rarity={ownedRarity} size={34} /> : <span style={{ opacity: 0.25, fontSize: 16 }}>?</span>}
      {count > 1 && <span className="count">{count}</span>}
      {ownedRarity && <span className="rarity-tag">{ownedRarity}</span>}
    </div>
  );
}
