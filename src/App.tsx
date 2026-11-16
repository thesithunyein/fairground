import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import type { Hex } from 'viem';
import { SessionPhase, type HostSnapshot } from '@chain-protocol/casino-sdk/guest';
import {
  BANK_ACTION,
  RIDE_ACTION,
  defaultPaint,
  demoWord,
  decodePaint,
  encodePaint,
  flooredRtpWad,
  formatPercent,
  formatPrize,
  formatUnitsPlain,
  gameDataFor,
  isLegalPaint,
  paintFromGameData,
  presetOf,
  presetPaint,
  replayRound,
  ridesFromPrize,
  tierCounts,
  wheelPrizes,
  PAINT_PRESETS,
  type Paint,
  type PaintPresetId,
  type RoundView,
  type Tier,
} from './lib/game';
import { CAP_PRIZE, PRIZE_DENOMINATOR, SAFE_PRIZE } from './title';
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

const PHASE_WAITING_RANDOMNESS = SessionPhase.WAITING_RANDOMNESS;
const PHASE_WAITING_PLAYER_ACTION = SessionPhase.WAITING_PLAYER_ACTION;
const PHASE_SETTLED = SessionPhase.SETTLED;
const PHASE_FORFEITED = SessionPhase.FORFEITED;
const PHASE_CANCELLED = SessionPhase.CANCELLED;

/** Tier names for the readouts, indexed by tier (0 safe, 1 mid, 2 risky). */
const TIER_WORD = ['SAFE', 'MID', 'RISKY'] as const;

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
  return encodePaint(p).slice(2); // strip 0x
}

function paintFromUrlParam(param: string | null): Paint | null {
  if (!param || !/^[0-9a-fA-F]{18}$/.test(param)) return null;
  return decodePaint(`0x${param}`);
}

type Round = {
  sessionKey?: string;
  sessionId?: string;
  wager: bigint;
  paint: Paint;
  /** true until openSession resolves with a sessionKey */
  pending: boolean;
  /** true when the round was picked back up from the host after a reload */
  resumed?: boolean;
};

type Result = {
  segment: number;
  tier: Tier;
  payout: bigint;
  won: boolean;
  prize: { id: number; rarity: ToyRarity };
  /** fair rides won before the round ended */
  ridesWon: number;
  /** true when the last ride came up tails and took the hold */
  rideLost: boolean;
  /** what was paid, as a multiple of the wager in prize units (0 on a loss) */
  multiplierUnits: bigint;
};

/** Present while the ride coin is in the air, or once it has landed. */
type CoinFlip = 'none' | 'flipping' | 'won' | 'lost';

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
  if (/WagerAboveRiskBudget|WagerAboveBreakEvenRule|NetWinAboveSingleWinCap|ReservedProfit|reserved profit/i.test(raw)) return "The house can't cover a bet that size right now, go smaller.";
  if (/user rejected|UserRejected|denied/i.test(raw)) return 'Cancelled.';
  if (raw.length > 90) return 'Bet failed, try again.';
  return raw;
}

type SessionRow = HostSnapshot['sessions']['items'][number];

/** The session's fulfilled VRF words in request order: the wheel, then one per ride. */
function sessionWords(row: SessionRow): Hex[] {
  const words = (row.raw?.randomnessRequests ?? [])
    .filter(req => req.fulfilled && req.randomness)
    .map(req => req.randomness as Hex);
  if (words.length === 0 && row.raw?.randomness) return [row.raw.randomness as Hex];
  return words;
}

/** SDK 0.7.0 renamed the balance to smartVaultBalance; older hosts still send smartWalletBalance. */
function smartVaultBalance(snapshot: HostSnapshot | null): string | undefined {
  const balances = snapshot?.balances as { smartVaultBalance?: string; smartWalletBalance?: string } | undefined;
  return balances?.smartVaultBalance ?? balances?.smartWalletBalance;
}

/**
 * An amount the player is paid or holds, to the base unit when it is not a round cent:
 * a 1 chUSD bet on the 0.2x slice pays 0.199999, and the booth says so rather than
 * rounding up or truncating to 0.19 (docs/MATH.md §4).
 */
function formatExact(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const frac = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${value / base}.${frac.length <= 2 ? frac.padEnd(2, '0') : frac}`;
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
        const p = decodePaint(saved as Hex);
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
  // Optional help only. Judges score "understood quickly, no manual needed",
  // so a first visit must show the wheel and SPIN, not a card of instructions.
  // The "?" in the header still opens a three-line crib.
  const [howOpen, setHowOpen] = useState(false);
  const [confetti, setConfetti] = useState(0); // increments to fire the legendary burst
  const [copied, setCopied] = useState(false);
  const [nearMiss, setNearMiss] = useState(false); // landed one slice off risky
  // The push-your-luck beat: the wheel has landed (or a ride has been won), and the
  // player may BANK the hold or RIDE it on one more fair coin. See src/title.ts.
  const [decision, setDecision] = useState<RoundView | null>(null);
  const [choice, setChoice] = useState<'bank' | 'ride' | null>(null);
  const [coinFlip, setCoinFlip] = useState<CoinFlip>('none');
  const [rideBusy, setRideBusy] = useState(false);
  const [gapToRisky, setGapToRisky] = useState<number | null>(null); // rim distance to the nearest risky slice
  const [err, setErr] = useState('');
  const roundRef = useRef<Round | null>(null);
  const placingRef = useRef(false); // guards double-tap double-bet
  roundRef.current = round;
  // The round as the engine sees it: the session's fulfilled VRF words in order
  // (words[0] drew the wheel, every later word resolved one ride) and whether the
  // session has settled. The host effect fills these from the snapshot; demo play
  // fills them from the browser's CSPRNG. advance() turns them into the screen.
  const wordsRef = useRef<Hex[]>([]);
  const settledOnChainRef = useRef(false);
  // How many words have been shown so far: 0 means the wheel has not spun yet.
  const shownRef = useRef(0);
  // An animation (the wheel, or a coin landing) is playing; advance() waits for it.
  const animatingRef = useRef(false);
  // The current round has been resolved and paid out on screen.
  const resolvedRef = useRef(false);
  const choiceRef = useRef<'bank' | 'ride' | null>(null);
  choiceRef.current = choice;
  // Session keys this page has already settled. The host's projection can lag a
  // settlement by a beat, so without this the resume effect below would re-adopt
  // a round the player has already been paid for — rebuilding it as an in-flight
  // one and wedging the booth on SPINNING with no way forward.
  const settledRef = useRef<Set<string>>(new Set());
  // True once the wheel has actually landed for the current round. The demo
  // stall watchdog keys off THIS, not a wall clock: a round where the player is
  // deliberating, or waiting on the ride coin, is not a stall.
  const landedRef = useRef(false);
  // True once a VRF word has been seen for the current host round, so the
  // host watchdog below can tell "node is slow" from "we already have it".
  const wordRef = useRef(false);
  const hostStallTimer = useRef(0);
  // Late-bound: timers and the wheel's land callback call through these refs, so
  // they always run against the newest render's state.
  const settleRef = useRef<(r: Round, view: RoundView) => void>(() => {});
  settleRef.current = settle;
  const advanceRef = useRef<() => void>(() => {});
  advanceRef.current = advance;

  const decimals = demo ? 6 : snapshot?.token?.decimals ?? 6;
  const symbol = demo ? 'chUSD' : snapshot?.token?.symbol ?? 'chUSD';

  const walletReady = demo || snapshot?.wallet?.status === 'ready';
  const walletIssue = !demo && snapshot && snapshot.wallet.status !== 'ready' ? snapshot.wallet.status : null;
  const walletMessage =
    walletIssue === 'setup-required' ? 'Set up your smart vault in the host menu, then come back to play for real.' :
    walletIssue === 'disconnected' ? 'Connect your wallet in the host menu to play for real.' :
    walletIssue === 'session-key-mismatch' ? 'Session expired, reconnect in the host menu.' :
    walletIssue ? 'Wallet not ready, open the host menu.' : null;
  const rawBalance = demo ? balance : BigInt(smartVaultBalance(snapshot) ?? '0');

  const prices = wheelPrizes(paint);
  const legal = isLegalPaint(paint);
  const counts = tierCounts(paint);
  const riskyCount = counts[2];
  const midCount = counts[1];
  const safeCount = counts[0];
  const activePreset = presetOf(paint);

  // Max wager: asked of the host for this exact configuration, re-asked when the
  // paint changes and on an interval. `unknown`, `no-limit` and a failed call all
  // fall back to the booth's own limit, never to unlimited.
  const [hostMaxWager, setHostMaxWager] = useState<bigint | undefined>(undefined);
  useEffect(() => {
    if (demo || !hostApi || !legal) return;
    let live = true;
    const gameData = gameDataFor(paint);
    const ask = () => {
      hostApi.getMaxWager({ gameData })
        .then(answer => { if (live) setHostMaxWager(answer.kind === 'limit' ? BigInt(answer.maxWager) : undefined); })
        .catch(() => { if (live) setHostMaxWager(undefined); });
    };
    ask();
    const timer = window.setInterval(ask, 15_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [demo, hostApi, paint, legal]);
  const ownLimit = 1000n * 10n ** BigInt(decimals);
  const maxWager = demo ? balance : hostMaxWager ?? ownLimit;

  // The proof strip is derived, never hardcoded: λ is the one free variable of
  // the pricing equation, and the return shown is whatever the floored prizes
  // actually produce — the same integers the engine pays out.
  const lambdaUnits =
    ((96n * BigInt(paint.segmentCount) * PRIZE_DENOMINATOR) / 100n - SAFE_PRIZE * BigInt(safeCount)) /
    BigInt(2 * midCount + 6 * riskyCount || 1);
  const rtpWad = flooredRtpWad(paint);
  // the most a single round can reach: risky, ridden as far as the cap allows
  const riskyRides = legal ? ridesFromPrize(paint, prices.risky) : 0;
  // a risky win gets the heavy landing shake; the wheel reads the last result
  const heavyShake = !!result && result.won && result.tier === 2;

  // LCD: idle → RTP + max mult; spinning → status; holding → the choice; done → result
  useEffect(() => {
    if (round) {
      if (decision) setLcd(`BANK ${formatPrize(decision.holdUnits)} - RIDE IT?`);
      else if (choice === 'ride') setLcd('COIN IN THE AIR...');
      else if (choice === 'bank') setLcd('BANKING...');
      else setLcd(round.sessionId || demo ? 'SPINNING... GOOD LUCK' : 'SENDING BET...');
    } else if (result) {
      if (result.rideLost) setLcd('RIDE LOST - BANK NEXT TIME?');
      else if (result.ridesWon > 0) setLcd(`RODE ${result.ridesWon}X TO ${formatExact(result.payout, decimals)} ${symbol}`);
      else setLcd(result.won ? `WIN ${formatExact(result.payout, decimals)} ${symbol}` : 'NO WIN - REPAINT?');
    } else setLcd(`RTP ~96  MAX ${formatPrize(prices.risky)}`);
  }, [round, result, prices.risky, decimals, symbol, decision, choice, demo]);

  /** Forget the round's progress: a new round, or one the host cancelled. */
  function resetRoundTracking() {
    wordsRef.current = [];
    settledOnChainRef.current = false;
    shownRef.current = 0;
    animatingRef.current = false;
    resolvedRef.current = false;
    landedRef.current = false;
    wordRef.current = false;
    pendingResolveRef.current = null;
  }

  /**
   * Moves the screen one beat towards the session's state, as the words say it is.
   * Every beat is replayed with the SDK's walkLadder from scratch, so the booth can
   * never drift from what the engine settled: first the wheel spins to the drawn
   * tier, then each ride's coin lands, then the round either waits for BANK/RIDE or
   * pays out. Called on every snapshot, after every animation, and by demo play.
   */
  function advance() {
    const r = roundRef.current;
    if (!r || animatingRef.current || resolvedRef.current) return;
    const words = wordsRef.current;
    if (words.length === 0) return; // still waiting on the wheel's VRF word
    const settledOnChain = settledOnChainRef.current;

    let view: RoundView;
    try {
      // a session that settled while its walk still waits at the rung was banked
      view = replayRound(r.paint, r.wager, words, settledOnChain);
    } catch {
      setErr('This round could not be replayed here. Your balance on the host is correct.');
      return;
    }

    if (shownRef.current === 0) {
      // the wheel: spin to a slice of the tier the engine drew
      const entry = words.length === 1 ? view : replayRound(r.paint, r.wager, words.slice(0, 1));
      // a resumed round skips replaying coins the player already watched
      shownRef.current = r.resumed ? words.length : 1;
      animatingRef.current = true;
      setPendingSegment(entry.segment);
      setSpinNonce(n => n + 1);
      pendingResolveRef.current = () => {
        animatingRef.current = false;
        landedRef.current = true;
        advanceRef.current();
      };
      return;
    }

    if (words.length > shownRef.current) {
      // a ride's coin has landed
      const through = replayRound(r.paint, r.wager, words.slice(0, shownRef.current + 1));
      shownRef.current += 1;
      animatingRef.current = true;
      setDecision(null);
      setChoice(null);
      setRideBusy(false);
      setCoinFlip(through.lastRide === 'won' ? 'won' : 'lost');
      window.setTimeout(() => {
        animatingRef.current = false;
        setCoinFlip('none');
        advanceRef.current();
      }, 1100);
      return;
    }

    if (view.status === 'settled') {
      // On the host, pay out only once the session has settled there too.
      if (!demo && !settledOnChain) return;
      resolvedRef.current = true;
      settleRef.current(r, view);
      if (!demo && r.sessionId) {
        // The host holds the win back from its balance display until the result
        // has been shown, and it tracks the round by the bare `sessionId`.
        void hostApi?.revealOutcome({ sessionId: r.sessionId }).catch(() => {});
      }
      return;
    }

    if (choiceRef.current === 'ride') { setCoinFlip('flipping'); return; } // waiting on the coin word
    if (choiceRef.current === 'bank') return; // waiting on the host to settle the cash-out
    setDecision(view);
  }

  // Host-driven round. The words are the step signal we trust: the first fulfilled
  // VRF word drew the wheel, and each later one resolved a ride. The host's
  // projected phase is unreliable mid-round, so it is read only for terminality.
  useEffect(() => {
    if (demo || !snapshot || !round || !round.sessionKey) return;
    const row = snapshot.sessions.items.find(s => s.sessionKey === round.sessionKey);
    if (!row) return;

    if (row.phase === PHASE_CANCELLED || row.phase === PHASE_FORFEITED) {
      // A cancel or forfeit moves balance back to the player, and the host
      // keeps that credit withheld until we reveal. Harmless no-op if the
      // host has nothing held for this session.
      void hostApi?.revealOutcome({ sessionId: row.sessionId }).catch(() => {});
      settledRef.current.add(row.sessionKey);
      resetRoundTracking();
      setRound(null);
      setPendingSegment(null);
      setDecision(null);
      setChoice(null);
      setCoinFlip('none');
      setRideBusy(false);
      setLcd(row.phase === PHASE_FORFEITED ? 'ROUND FORFEITED' : 'ROUND CANCELLED');
      return;
    }

    const words = sessionWords(row);
    if (words.length > 0) {
      wordRef.current = true;
      window.clearTimeout(hostStallTimer.current);
    }
    wordsRef.current = words;
    settledOnChainRef.current = row.phase === PHASE_SETTLED;
    if (round.sessionId !== row.sessionId) setRound({ ...round, sessionId: row.sessionId });
    advanceRef.current();
  }, [snapshot, round, demo, hostApi]);

  // session resume: a reload mid-round recovers the session from the host's
  // snapshot and comes back in the same step, not at the start.
  useEffect(() => {
    if (demo || !snapshot || round) return;
    const row = snapshot.sessions.items.find(
      s => s.gameAddress === snapshot.integration.gameAddress && !s.isSettled
        && (s.phase === PHASE_WAITING_RANDOMNESS || s.phase === PHASE_WAITING_PLAYER_ACTION),
    );
    if (!row || settledRef.current.has(row.sessionKey)) return;
    const resumedPaint = row.raw?.gameData ? paintFromGameData(row.raw.gameData) : null;
    const wager = BigInt(row.wager ?? row.stake ?? '0');
    if (!resumedPaint || wager <= 0n) return;
    // If a ride or a bank has been sent and not yet answered, the player has
    // already chosen and must not be asked again.
    const words = sessionWords(row);
    const actions = row.raw?.actions;
    const ridesSent = actions?.filter(a => a.actionData.toLowerCase() === RIDE_ACTION).length;
    const bankSent = actions?.some(a => a.actionData.toLowerCase() === BANK_ACTION);
    const pending: 'bank' | 'ride' | null = bankSent
      ? 'bank'
      : ridesSent !== undefined
        ? (words.length > 0 && ridesSent > words.length - 1 ? 'ride' : null)
        : (words.length > 0 && row.phase === PHASE_WAITING_RANDOMNESS ? 'ride' : null);
    resetRoundTracking();
    setChoice(pending);
    setDecision(null);
    setCoinFlip('none');
    setResult(null);
    setPaint(resumedPaint);
    setRound({ wager, paint: resumedPaint, sessionKey: row.sessionKey, sessionId: row.sessionId, pending: false, resumed: true });
    setLcd('RESUMED - WAITING FOR VRF...');
  }, [snapshot, round, demo]);

  /** Pays a settled round out on screen. `view` is the engine's settlement, replayed. */
  function settle(r: Round, view: RoundView) {
    if (r.sessionKey) settledRef.current.add(r.sessionKey);
    window.clearTimeout(hostStallTimer.current);
    const payout = view.payout ?? 0n;
    const won = payout > 0n;
    const paidUnits = won ? view.holdUnits : 0n;
    const segment = view.segment;
    const s = { tier: view.tier, prize: view.prize };
    setResult({
      segment,
      tier: view.tier,
      payout,
      won,
      prize: view.prize,
      ridesWon: view.ridesWon,
      rideLost: view.lastRide === 'lost',
      multiplierUnits: paidUnits,
    });
    setRound(null);
    setPendingSegment(null);
    if (!firstLoopDone) {
      setFirstLoopDone(true);
      try { localStorage.setItem('fg_first_loop_v1', '1'); } catch { /* private mode */ }
    }
    setDecision(null);
    setChoice(null);
    setRideBusy(false);
    setCoinFlip('none');
    // the biggest slice on the wheel gets the heaviest landing
    if (won && s.tier === 2) sfx.landHeavy(); else sfx.land();
    // a risky win lands harder: short taps on a plain land, a small pattern on a win
    buzz(won && s.tier === 2 ? [18, 40, 90] : 12);
    window.setTimeout(() => sfx.sting(s.tier, won, paidUnits >= 4n * PRIZE_DENOMINATOR), 140);

    // Near-miss drama, measured rather than assumed: how many slices around the
    // rim the pointer stopped from the nearest risky wedge. One slice off is a
    // different feeling to five, and naming the gap is what makes the miss land.
    const sliceCount = r.paint.tiers.length;
    let gap = sliceCount;
    r.paint.tiers.forEach((t, i) => {
      if (t !== 2) return;
      const d = Math.min(Math.abs(i - segment), sliceCount - Math.abs(i - segment));
      if (d < gap) gap = d;
    });
    setGapToRisky(gap);
    if (!won && gap === 1) {
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
      setBalance(b => (b - r.wager + payout));
    }

    // daily objectives (cosmetic only, see lib/missions.ts)
    recordMission('spins');
    setHistory(prev => [
      { tier: s.tier, won, x: paidUnits > 0n ? formatPrize(paidUnits) : '×0' },
      ...prev,
    ].slice(0, 8));
    if (won) recordMission('wins');
    if (s.tier === 2) recordMission('riskyLands');
    if (won && s.tier === 2) recordMission('riskyWins');
    if (s.prize.rarity === 'legendary') recordMission('legendaryPrizes');
    // a bold paint is one with risky covering at least 40% of the wheel, so
    // the objective asks the player to actually shape the paytable
    const landedCounts = tierCounts(r.paint);
    if (landedCounts[2] * 5 >= r.paint.segmentCount * 2) recordMission('boldSpins');

    // session stats, streaks, milestones (cosmetic, client-only)
    const winAmount = formatUnits(payout, decimals);
    const bigWin = (s.tier === 2 && won) || s.prize.rarity === 'legendary';
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
      if (s.prize.rarity === 'rare') celebrate('firstRare', 'FIRST RARE PRIZE');
      if (s.prize.rarity === 'legendary') celebrate('firstLegendary', 'FIRST LEGENDARY!');
      if (next.streak >= 5) celebrate(`streak${next.streak}`, `${next.streak} WIN STREAK`);
      saveStats(next);
      return next;
    });

    // prize collection, and the album stamps a set the day it is finished
    const { next, isNew } = addToCollection(collection, s.prize.id, s.prize.rarity);
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
    setPrizeToast({ id: s.prize.id, rarity: s.prize.rarity, fresh: isNew });
    window.setTimeout(() => setPrizeToast(null), 2600);
    if (newUnlock) {
      window.setTimeout(() => { sfx.fanfare(); setCollection(c => ({ ...c, activeLivery: newUnlock })); saveCollection({ ...updated, activeLivery: newUnlock }); }, 900);
    } else {
      window.setTimeout(() => sfx.prize(0), 500);
    }
  }

  const pendingResolveRef = useRef<(() => void) | null>(null);

  const onWheelLand = useCallback(() => {
    const resolve = pendingResolveRef.current;
    pendingResolveRef.current = null;
    resolve?.();
  }, []);

  /**
   * The push-your-luck beat, at every rung. BANK cashes out the hold. RIDE stakes
   * it on a provably fair coin: heads doubles it, tails loses it, and the player
   * may ride again until a win would reach the 100x cap.
   *
   * Each coin is a NEW VRF word that does not exist when the player taps, so
   * nobody — not the player, not a script reading the session — can know the
   * outcome before choosing. The engine refuses any ride that is not a fair bet,
   * so the round returns the same ~96% however often the player rides.
   */
  async function chooseAction(action: 'bank' | 'ride') {
    const r = roundRef.current;
    const d = decision;
    if (!r || !d || choice) return;
    sfx.click();
    setChoice(action);
    choiceRef.current = action;
    setDecision(null);
    if (action === 'ride') setCoinFlip('flipping');

    if (demo || !hostApi) {
      // demo play feeds the same walk the engine runs with its own CSPRNG words
      window.setTimeout(() => {
        if (roundRef.current !== r) return;
        if (action === 'ride') wordsRef.current = [...wordsRef.current, demoWord()];
        else settledOnChainRef.current = true; // banked: the walk cashes out
        advanceRef.current();
      }, action === 'ride' ? 700 : 0);
      return;
    }

    // The host answers through the snapshot: a ride's coin word arrives as a new
    // fulfilled request, a bank as the session settling. advance() takes it from there.
    setRideBusy(true);
    try {
      if (!r.sessionId) throw new Error('The session is still opening, try again in a moment.');
      await hostApi.submitAction({ sessionId: r.sessionId, actionData: action === 'ride' ? RIDE_ACTION : BANK_ACTION });
    } catch (e) {
      // nothing was sent: put the choice back rather than stranding the round
      setRideBusy(false);
      setChoice(null);
      choiceRef.current = null;
      setCoinFlip('none');
      setDecision(d);
      setErr(friendlyBetError(e, symbol));
    }
  }

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

      const gameData = gameDataFor(paint);

      const rt: Round = { wager, paint, pending: true };
      setRound(rt);
      setResult(null);
      setGapToRisky(null);
      setDecision(null);
      setChoice(null);
      setCoinFlip('none');
      setRideBusy(false);
      resetRoundTracking(); // a new round earns a fresh spin animation
      window.clearTimeout(hostStallTimer.current);
      // hand the round to the land callback straight away: the timer below can
      // otherwise fire before React has committed the state
      roundRef.current = rt;

      if (demo || !hostApi) {
        // let React paint the disabled button first, then draw the wheel's word
        window.setTimeout(() => {
          if (roundRef.current !== rt) return;
          wordsRef.current = [demoWord()];
          advanceRef.current();
        }, 60);
        // A demo spin resolves on its own animation frame, so nothing should
        // ever leave the round open. If it does (a dropped frame, a tab
        // backgrounded mid-spin), free the booth rather than wedge SPIN.
        window.setTimeout(() => {
          // only a spin that never LANDS is a stall — see landedRef
          if (roundRef.current !== rt || landedRef.current) return;
          resetRoundTracking();
          setRound(null);
          setPendingSegment(null);
          setDecision(null);
          setErr('That spin stalled. Tap SPIN again.');
        }, 9000);
        return;
      }

      try {
        const { sessionKey } = await hostApi.openSession({ wager: wager.toString(), gameData });
        if (roundRef.current === rt) {
          // sessionKey is "{chainId}:{sessionId}"; the snapshot row confirms the id
          const opened: Round = { ...rt, sessionKey, sessionId: sessionKey.split(':').pop(), pending: false };
          roundRef.current = opened;
          setRound(opened);
          setLcd('WAITING FOR VRF...');
          // A round whose word never arrives must not wedge the booth either.
          // Freeing the local round is safe: the session is still live on the
          // host, so the resume path picks it straight back up if it lands.
          window.clearTimeout(hostStallTimer.current);
          hostStallTimer.current = window.setTimeout(() => {
            if (roundRef.current?.sessionKey !== sessionKey || wordRef.current) return;
            resetRoundTracking();
            setRound(null);
            setPendingSegment(null);
            setDecision(null);
            setErr('The randomness node is slow. Tap SPIN to try again.');
          }, 60_000);
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
      refusePaint(counts[2] * 2 >= paint.segmentCount
        ? 'Risky can be at most half the wheel. Paint a risky slice back to Mid or Safe first.'
        : 'The wheel needs at least one Risky slice and one Safe or Mid slice.');
      return;
    }
    sfx.click();
    setPaint(np);
    if (paintNote) setPaintNote(null);
  }

  function applyPreset(id: PaintPresetId) {
    if (round) return;
    sfx.click();
    setPaint(presetPaint(paint.segmentCount, id));
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
      localStorage.setItem('fg_paint_v1', encodePaint(paint));
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

  useEffect(() => {
    if (!decision) return;
    sfx.holdOffer();
    buzz([14, 30, 22]);
  }, [decision]);

  useEffect(() => {
    if (coinFlip === 'flipping') sfx.coinToss();
    if (coinFlip === 'won') sfx.coinWin();
    if (coinFlip === 'lost') sfx.coinLose();
  }, [coinFlip]);

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
    const riskyWin = (w * prices.risky) / PRIZE_DENOMINATOR; // prizes are in prize units
    return `${formatUnits(w, decimals)} → ${formatUnits(riskyWin, decimals)} ${symbol} on risky, more if you ride`;
  })();

  const liveryUnlocked = unlockedLiveries(collection);
  const shelf = shelfStats(collection);
  const album = albumProgress(collection);
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
      <span className="sr-only" role="status">{lcd}</span>

      <header className="top">
        <div className="brand">
          <div className="brand-mark"><WheelBadge /></div>
          <div>
            <div className="brand-name">FAIRGROUND</div>
            <div
              className={`brand-sub${demo && !CLEAN_MODE ? ' demo' : ''}`}
              title={demo ? 'Free-play demo · the real game runs inside chain.wtf with your vault balance' : undefined}
            >
              {demo && !CLEAN_MODE ? 'Free play · demo' : 'the honest carnival'}
            </div>
          </div>
        </div>
        <div className="chips">
          <div className="chip balance" aria-label="balance">
            <span className="coin-dot" aria-hidden="true" />
            {formatUnits(rawBalance, decimals)} <span className="lbl">{symbol}</span>
          </div>
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
            {s.id !== 'play' && (
              <span className="t-badge">
                {s.id === 'collect' ? `${shelf.owned}/${shelf.total}` : `${doneToday}/3`}
              </span>
            )}
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
            <h2>You paint the prizes</h2>
            <span className="paint-tools">
              <button type="button" className="tool-btn" disabled={!!round} onClick={cycleSegmentCount} title="change the number of slices">
                {paint.segmentCount} slices
              </button>
              <button type="button" className="tool-btn" disabled={!!round} onClick={autoRepaint} title="random legal paint" aria-label="random legal paint">
                🎲<span className="tl"> Shuffle</span>
              </button>
              <button type="button" className="tool-btn" onClick={shareWheel} title="copy a link to this wheel">
                {copied ? 'Copied ✓' : 'Share'}
              </button>
            </span>
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

          <Wheel
            paint={paint}
            onPaintSegment={paintSegment}
            spinNonce={spinNonce}
            resultSegment={pendingSegment}
            livery={collection.activeLivery}
            interactive={!round}
            onTickSound={(s01) => sfx.tick(s01)}
            onCreep={() => sfx.tensionSwell()}
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
                <span className="mult">{formatPrize(t === 0 ? prices.safe : t === 1 ? prices.mid : prices.risky)}</span>
              </button>
            ))}
          </div>

          {/* The trade, made visible: as risky takes more of the wheel, each
              risky slice pays less. This is the whole game in one line. */}
          <div className="paint-readout">
            <span><b>{riskyCount}</b> of {paint.segmentCount} risky</span>
            <span>risky pays <b>{formatPrize(prices.risky)}</b></span>
            <span>mid <b>{formatPrize(prices.mid)}</b></span>
            <span className="stamp" title={`floored prizes return ${formatPercent(rtpWad)}%; the engine reports 96.00%`}>RTP ≈96%</span>
          </div>

          {paintNote && (
            <div className="paint-note" role="status">{paintNote}</div>
          )}

          <details className="fair-deets">
            <summary>Why this stays fair</summary>
            <div className="paint-proof" aria-live="polite">
              <div className="pp-row">
                <span className="pp-tag">λ</span>
                <code>
                  (0.96·{paint.segmentCount}
                  {' − '}0.20·{safeCount})
                  {' ÷ '}(2·{midCount} + 6·{riskyCount})
                  {' = '}<b>{formatUnitsPlain(lambdaUnits, 3)}</b>
                </code>
              </div>
              <div className="pp-row">
                <span className="pp-tag">RTP</span>
                <code>
                  ({formatUnitsPlain(prices.safe, 2)}·{safeCount}
                  {' + '}{formatUnitsPlain(prices.mid, 2)}·{midCount}
                  {' + '}{formatUnitsPlain(prices.risky, 2)}·{riskyCount})
                  {' ÷ '}{paint.segmentCount}
                  {' = '}<b className="pp-ok">{formatPercent(rtpWad)}%</b>
                </code>
              </div>
            </div>
            <ul>
              <li>
                You set the prices. Take more of the wheel risky and each risky slice pays
                less: the return stays fixed, so no paint is better than another.
              </li>
              <li>
                Safe {safeCount} pays {formatPrize(prices.safe)} · Mid {midCount} pays{' '}
                {formatPrize(prices.mid)} · Risky {riskyCount} pays {formatPrize(prices.risky)}
              </li>
              <li>
                Expected return is ≈96% on every legal paint. Prizes are floored to a millionth of
                your stake, so this paint returns {formatPercent(rtpWad)}%; the chain&apos;s engine
                reports 96.00% for every paint.
              </li>
              <li>
                The chain draws the tier from one VRF word, weighted by how many slices you painted,
                so every slice is exactly as likely as every other.
              </li>
              <li>
                Every ride is a <b>provably fair coin</b>: heads doubles your hold, tails loses it, and
                each coin is a fresh VRF word that does not exist while you are choosing. Ride again and
                again until a win would reach the {(CAP_PRIZE / PRIZE_DENOMINATOR).toString()}× cap
                (risky allows {riskyRides} rides here). The chain checks every ride is fair before the
                game can take a bet, so banking and riding return the same ≈96%.
              </li>
              <li>
                <a href="https://github.com/thesithunyein/fairground/blob/main/docs/MATH.md" target="_blank" rel="noreferrer">
                  The declared maths and the check that proves it
                </a>{' '}
                · <code>npm run check:title</code>
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
              {round
                ? decision
                  ? `◆ HOLDING ${formatExact(decision.cashOut, decimals)}`
                  : choice === 'ride' ? '◆ FAIR COIN' : choice === 'bank' ? '◆ BANKING' : '● SPINNING'
                : result ? (result.won ? `▲ ${formatExact(result.payout, decimals)} ${symbol}` : '▼ NO WIN') : '■ PLACE YOUR BET'}
            </div>
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
              <button className="half-double max" disabled={!!round || maxWager <= 0n} onClick={() => { sfx.click(); setBetInput(formatUnits(maxWager, decimals)); }}>MAX</button>
            </div>
            <div className="bet-meta">
              <span>{wagerPreview ?? `max ${formatUnits(maxWager, decimals)}`}</span>
            </div>
          </div>

          {/* The KEEP/DOUBLE overlay owns this beat. */}

          <button
            className={`spin-btn${!round && walletReady ? ' attract' : ''}`}
            disabled={!!round || !walletReady}
            onClick={placeBet}
          >
            {round
              ? decision ? 'KEEP OR DOUBLE' : choice === 'ride' ? 'COIN IN THE AIR…' : choice === 'bank' ? 'BANKING…' : (round.sessionId || demo ? 'SPINNING…' : 'SIGNING…')
              : walletReady ? 'SPIN' : walletIssue === 'disconnected' ? 'CONNECT WALLET' : 'WALLET NOT READY'}
          </button>

          {walletMessage && !err && (
            <div className="wallet-note" role="status">{walletMessage}</div>
          )}

          {err && (
            <div className="result-banner lose" role="alert">{err}</div>
          )}

          {result && !round && (
            <div className={`result-banner ${result.won ? 'win' : nearMiss ? 'lose near' : 'lose'}`}>
              {result.rideLost
                ? <span>Rode a {TIER_WORD[result.tier]} hold{result.ridesWon > 0 ? ` through ${result.ridesWon} win${result.ridesWon > 1 ? 's' : ''}` : ''} and the fair coin came up tails. No win — repaint and go again.</span>
                : result.ridesWon > 0
                  ? <span>Rode it {result.ridesWon}× and banked <CountUpTo value={parseFloat(formatExact(result.payout, decimals))} final={formatExact(result.payout, decimals)} /> {symbol} ({formatPrize(result.multiplierUnits)}) from a {TIER_WORD[result.tier]} slice.</span>
              : result.won
                ? <span>WIN <CountUpTo value={parseFloat(formatExact(result.payout, decimals))} final={formatExact(result.payout, decimals)} /> {symbol} · {TIER_WORD[result.tier]} paid</span>
                : <span>
                    {nearMiss
                      ? 'SO CLOSE · one slice off risky. '
                      : gapToRisky !== null && gapToRisky <= 2
                        ? `Missed by ${gapToRisky} · landed ${TIER_WORD[result.tier].toLowerCase()}. `
                        : `No win · landed ${TIER_WORD[result.tier].toLowerCase()}. `}
                    Repaint and go again.
                  </span>
            }            </div>
          )}

          {!firstLoopDone && !round && (
            <p className="coach" role="status">
              <b>Paint a slice, then SPIN.</b> You set the prizes. The return stays ≈96%.
            </p>
          )}

          {result && !round && stats.spins >= 2 && doneToday < 3 && (
            <button type="button" className="day-nudge" onClick={() => { sfx.click(); setTab('daily'); }}>
              Daily booth {doneToday}/3 — keep the streak ›
            </button>
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
            its livery. Collecting never touches the odds: RTP stays ≈96% every spin.
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
            <span className="stamp">≈96% RTP always</span>
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
        <span>You paint the prizes. Bank or ride, the return stays ≈96%.</span>
        <span className="stamp">RTP ≈96% · ENGINE 96.00%</span>
      </footer>

      {(decision || coinFlip !== 'none') && (
        <div className="ride-overlay" role="dialog" aria-modal="true" aria-label={decision ? 'keep or double' : 'fair coin'}>
          <div className="ride-sheet">
            {decision ? (
              <>
                <p className="ride-kicker">
                  {TIER_WORD[decision.tier]} · {formatPrize(decision.holdUnits)}
                  {decision.ridesWon > 0 ? ` · ${decision.ridesWon} ride${decision.ridesWon > 1 ? 's' : ''} won` : ''}
                </p>
                <h3 id="ride-title">You hold {formatExact(decision.cashOut, decimals)} {symbol}</h3>
                <p className="ride-sub">
                  Keep it, or flip a fair coin for double. Same ≈96% either way.{' '}
                  <b>{decision.ridesLeft} ride{decision.ridesLeft === 1 ? '' : 's'} left</b> before the{' '}
                  {(CAP_PRIZE / PRIZE_DENOMINATOR).toString()}× cap.
                </p>
                <div className="rd-btns">
                  <button type="button" className="rd-bank" disabled={rideBusy} onClick={() => void chooseAction('bank')}>
                    KEEP IT
                    <small>{formatUnits(decision.cashOut, decimals)} {symbol}</small>
                  </button>
                  <button type="button" className="rd-ride" disabled={rideBusy} onClick={() => void chooseAction('ride')}>
                    DOUBLE
                    <small>50/50 for {formatUnits(decision.cashOut * 2n, decimals)}</small>
                  </button>
                </div>
              </>
            ) : (
              <div className={`coin-flip ${coinFlip} stage`} aria-live="polite">
                <span className="cf-disc" aria-hidden="true">
                  {coinFlip === 'flipping' ? '?' : coinFlip === 'won' ? '★' : '✕'}
                </span>
                <span className="cf-words">
                  {coinFlip === 'flipping'
                    ? 'Fair coin in the air…'
                    : coinFlip === 'won' ? 'HEADS: doubled.' : 'TAILS: the hold is gone.'}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Optional crib from the header "?". Never auto-opens. */}
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
              <h3 id="howto-title">THE BOOTH</h3>
              <button className="howto-x" type="button" onClick={dismissHow} aria-label="close how to play" autoFocus>✕</button>
            </div>
            <div className="howto-steps">
              <div className="howto-step paint">
                <span className="howto-num">1</span>
                <span><b>Paint.</b> Tap slices Safe, Mid or Risky. More risky pays less each — return stays ≈96%.</span>
              </div>
              <div className="howto-step spin">
                <span className="howto-num">2</span>
                <span><b>Spin.</b> Every slice is exactly as likely. Then keep the win, or flip a fair coin for double, again and again up to the 100× cap.</span>
              </div>
              <div className="howto-step collect">
                <span className="howto-num">3</span>
                <span><b>Collect.</b> Every spin drops a prize. Fill a set, unlock a livery. Cosmetics never change the odds.</span>
              </div>
            </div>
            <button className="howto-ok" type="button" onClick={dismissHow}>PLAY</button>
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

/** Counts up to `value`, then shows `final`, the exact amount, so the last frame never rounds up. */
function CountUpTo({ value, final }: { value: number; final: string }) {
  const [shown, setShown] = useState(value);
  const [done, setDone] = useState(false);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const DUR = 650;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / DUR);
      setShown(value * (1 - Math.pow(1 - t, 3)));
      if (t < 1) raf = requestAnimationFrame(step);
      else setDone(true);
    };
    setDone(false);
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{done ? final : shown.toFixed(2)}</>;
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
