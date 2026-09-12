import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { computeMaxWager } from './chain-sdk/guest';
import {
  defaultPaint,
  encodeGameData,
  outcomeFromRandomness,
  priceWheel,
  formatMultiplier,
  isLegalPaint,
  demoRandomness,
  demoSeed,
  type Paint,
  type Tier,
} from './lib/game';
import { useCasinoHost } from './lib/useCasinoHost';
import { Wheel } from './components/Wheel';
import { PrizeSprite, BootWheel, WheelBadge } from './components/Prizes';
import {
  loadCollection,
  saveCollection,
  addToCollection,
  unlockedLiveries,
  shelfStats,
  type Collection,
  type ToyRarity,
} from './lib/collection';
import * as sfx from './lib/sound';

const DEMO_BALANCE_START = 1000_000000n; // 1000.00 (6 decimals)
const PHASE_SETTLED = 3;
const PHASE_FORFEITED = 4;
const PHASE_CANCELLED = 5;
const isTerminal = (p: number | undefined) => p === PHASE_SETTLED || p === PHASE_FORFEITED || p === PHASE_CANCELLED;

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

function formatUnits(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const int = value / base;
  const frac = (value % base).toString().padStart(decimals, '0').slice(0, 2);
  return `${int}.${frac}`;
}

export default function App() {
  const { hostApi, snapshot, mode } = useCasinoHost();
  const demo = mode === 'demo';

  const [paint, setPaint] = useState<Paint>(defaultPaint);
  const [paintTier, setPaintTier] = useState<Tier>(2);
  const [betInput, setBetInput] = useState('1');
  const [round, setRound] = useState<Round | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [spinNonce, setSpinNonce] = useState(0);
  const [pendingSegment, setPendingSegment] = useState<number | null>(null);
  const [collection, setCollection] = useState<Collection>(() => loadCollection());
  const [prizeToast, setPrizeToast] = useState<{ id: number; rarity: ToyRarity; fresh: boolean } | null>(null);
  const [muted, setMuted] = useState(() => { sfx.initSound(); return sfx.isMuted(); });
  const [balance, setBalance] = useState(DEMO_BALANCE_START);
  const [lcd, setLcd] = useState('FAIRGROUND v1.0');
  const [err, setErr] = useState('');
  const roundRef = useRef<Round | null>(null);
  roundRef.current = round;

  const decimals = demo ? 6 : snapshot?.token?.decimals ?? 6;
  const symbol = demo ? 'chUSD' : snapshot?.token?.symbol ?? 'chUSD';

  const walletReady = demo || snapshot?.wallet?.status === 'ready';
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
        settle(outcome.segment, outcome);
        void hostApi?.revealOutcome({ sessionId: round.sessionKey! }).catch(() => {});
      };
    }
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
    window.setTimeout(() => sfx.sting(outcome.tier, won, outcome.multiplierWad >= 4n), 140);

    // demo balance bookkeeping
    if (demo) {
      setBalance(b => (b - r.wager + outcome.payout));
    }

    // prize collection
    const { next, isNew } = addToCollection(collection, outcome.prize.id, outcome.prize.rarity);
    setCollection(next);
    saveCollection(next);
    const before = unlockedLiveries(collection);
    const after = unlockedLiveries(next);
    const newUnlock = [...after].find(l => !before.has(l));
    setPrizeToast({ id: outcome.prize.id, rarity: outcome.prize.rarity, fresh: isNew });
    window.setTimeout(() => setPrizeToast(null), 2600);
    if (newUnlock) {
      window.setTimeout(() => { sfx.fanfare(); setCollection(c => ({ ...c, activeLivery: newUnlock })); saveCollection({ ...next, activeLivery: newUnlock }); }, 900);
    } else {
      window.setTimeout(() => sfx.prize(0), 500);
    }
  }

  const pendingResolveRef = useRef<(() => void) | null>(null);

  const spinDemo = useCallback(() => {
    const r = roundRef.current;
    if (!r) return;
    const seed = demoSeed();
    const rnd = demoRandomness(seed);
    const outcome = outcomeFromRandomness(r.wager, r.paint, rnd);
    setPendingSegment(outcome.segment);
    setSpinNonce(n => n + 1);
    // landing callback resolves the round
    pendingResolveRef.current = () => settle(outcome.segment, outcome);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection]);

  const onWheelLand = useCallback(() => {
    const resolve = pendingResolveRef.current;
    pendingResolveRef.current = null;
    resolve?.();
  }, []);

  async function placeBet() {
    setErr('');
    if (round) return;
    if (!legal) { setErr('Paint needs all three tiers (risky ≤ half the wheel).'); return; }
    const wager = parseUnits(betInput, decimals);
    if (wager <= 0n) { setErr('Enter a bet amount.'); return; }
    if (wager > maxWager) { setErr(`Max bet right now: ${formatUnits(maxWager, decimals)} ${symbol}`); return; }
    if (demo && wager > balance) { setErr('Not enough demo balance.'); return; }

    const gameData = encodeGameData(paint);

    if (demo || !hostApi) {
      setRound({ wager, paint, pending: true });
      setResult(null);
      // let React paint the disabled button first
      window.setTimeout(() => spinDemo(), 60);
      return;
    }

    setRound({ wager, paint, pending: true });
    setResult(null);
    try {
      const { sessionKey } = await hostApi.openSession({ wager: wager.toString(), gameData });
      if (roundRef.current && roundRef.current.pending) {
        setRound({ ...roundRef.current, sessionKey, pending: false });
        setLcd('WAITING FOR VRF...');
      }
    } catch (e) {
      setRound(null);
      setErr(e instanceof Error ? e.message : 'Bet failed — try again.');
    }
  }

  function paintSegment(i: number) {
    if (round) return;
    sfx.click();
    setPaint(p => {
      const tiers = [...p.tiers];
      tiers[i] = paintTier;
      const np = { ...p, tiers };
      return isLegalPaint(np) ? np : p; // keep wheel always legal
    });
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

  const wagerPreview = (() => {
    const w = parseUnits(betInput, decimals);
    if (w <= 0n) return null;
    const riskyWin = (w * prices.risky) / 10n ** 18n; // prices are WAD-scaled
    return `${formatUnits(w, decimals)} → up to ${formatUnits(riskyWin, decimals)} ${symbol} on risky`;
  })();

  const liveryUnlocked = unlockedLiveries(collection);
  const shelf = shelfStats(collection);

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
      {demo && <div className="overlay-badge">DEMO MODE — FREE PLAY</div>}

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
          <button className="icon-btn" onClick={() => setMuted(sfx.toggleMute())} aria-label="toggle sound">
            {muted ? '🔇' : '🔊'}
          </button>
        </div>
      </header>

      <main className="stage">
        <section className="panel">
          <div className="panel-title">
            <h2>The Wheel — paint it, then spin</h2>
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
        </section>

        <section className="controls">
          <div className="lcd-panel">
            <div className={result?.won ? 'lcd-win' : 'lcd-main'}>
              {round ? '● SPINNING' : result ? (result.won ? `▲ ${formatUnits(result.payout, decimals)} ${symbol}` : '▼ NO WIN') : '■ PLACE YOUR BET'}
            </div>
            <button className="icon-btn" style={{ boxShadow: 'none', background: '#2a2d2b', borderColor: '#2a2d2b', color: '#7dffb2' }} onClick={autoRepaint} title="random legal paint">🎲</button>
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
            {round ? (round.sessionId || demo ? 'SPINNING…' : 'SIGNING…') : walletReady ? 'SPIN' : 'WALLET NOT READY'}
          </button>

          {err && (
            <div className="result-banner lose" role="alert">{err}</div>
          )}

          {result && !round && (
            <div className={`result-banner ${result.won ? 'win' : 'lose'}`}>
              {result.won
                ? `WIN ${formatUnits(result.payout, decimals)} ${symbol} · ${result.tier === 2 ? 'RISKY' : result.tier === 1 ? 'MID' : 'SAFE'} paid`
                : `No win — landed ${result.tier === 2 ? 'risky' : result.tier === 1 ? 'mid' : 'safe'}. Repaint and go again.`}
            </div>
          )}

          <div className="panel">
            <div className="panel-title">
              <h2>Prize Shelf</h2>
              <span className="hint">{shelf.owned}/{shelf.total} collected</span>
            </div>
            <div className="shelf-row">
              {[0, 1, 2, 3, 4, 5].map(toy => (
                <ShelfCell key={toy} toy={toy} collection={collection} fresh={prizeToast?.fresh && prizeToast.id === toy} />
              ))}
            </div>
            <div className="livery-row">
              {['classic', 'midway', 'mint', 'twilight'].map(id => {
                const unlocked = liveryUnlocked.has(id);
                const active = collection.activeLivery === id;
                return (
                  <button
                    key={id}
                    className={`livery-dot ${id}${active ? ' active' : ''}${unlocked ? '' : ' locked'}`}
                    title={unlocked ? id : `locked — ${id === 'midway' ? 'all 6 common' : id === 'mint' ? 'all 6 rare' : id === 'twilight' ? 'all 6 legendary' : 'default'}`}
                    onClick={() => { if (unlocked) { sfx.click(); const c = { ...collection, activeLivery: id }; setCollection(c); saveCollection(c); } }}
                  >
                    {unlocked ? '' : '🔒'}
                  </button>
                );
              })}
            </div>
            <div className="shelf-progress">
              <span>wheel colors change with every complete set</span>
              <span className="stamp">96% RTP always</span>
            </div>
          </div>
        </section>
      </main>

      <footer className="fair-note">
        <span>Provably fair: exactly-uniform wheel · VRF randomness · paytable recomputed on-chain from YOUR paint</span>
        <span className="stamp">DECLARED RTP 96% · HOUSE EDGE 4%</span>
      </footer>

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
