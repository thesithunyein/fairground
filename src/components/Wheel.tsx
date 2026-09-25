import { useEffect, useRef, useState } from 'react';
import { priceWheel, formatMultiplier, type Paint, type Tier } from '../lib/game';

const TIER_COLORS: Record<Tier, { fill: string; text: string }> = {
  0: { fill: 'var(--green)', text: '#ffffff' },
  1: { fill: 'var(--gold)', text: '#141414' },
  2: { fill: 'var(--red)', text: '#ffffff' },
};

const LIVERY_SCHEMES: Record<string, Record<Tier, { fill: string; text: string }>> = {
  classic: TIER_COLORS,
  midway: {
    0: { fill: '#2f6bff', text: '#ffffff' },
    1: { fill: '#ffd166', text: '#141414' },
    2: { fill: '#1d1f1e', text: '#ffd166' },
  },
  mint: {
    0: { fill: '#8fd6b4', text: '#141414' },
    1: { fill: '#2f9e44', text: '#ffffff' },
    2: { fill: '#116530', text: '#c8ffd9' },
  },
  twilight: {
    0: { fill: '#b99cff', text: '#141414' },
    1: { fill: '#7a4dff', text: '#ffffff' },
    2: { fill: '#3d1d8f', text: '#ffd7f0' },
  },
  // the mission ladder's seventh rung: an all-metal wheel
  gilded: {
    0: { fill: '#f2e2b0', text: '#141414' },
    1: { fill: '#f5b301', text: '#141414' },
    2: { fill: '#7a5c14', text: '#ffeeb8' },
  },
};

export function wheelColors(livery: string): Record<Tier, { fill: string; text: string }> {
  return LIVERY_SCHEMES[livery] ?? TIER_COLORS;
}

type SpinPhase = 'idle' | 'spinning' | 'done';

export function Wheel({
  paint,
  onPaintSegment,
  spinNonce,
  resultSegment,
  livery,
  interactive,
  onTickSound,
  onLand,
  heavyShake,
}: {
  paint: Paint;
  onPaintSegment?: (index: number) => void;
  /** increments every spin start */
  spinNonce: number;
  /** segment to land on (set when spin starts) */
  resultSegment: number | null;
  livery: string;
  interactive: boolean;
  onTickSound?: (speed01: number) => void;
  onLand?: () => void;
  /** a risky win lands harder than a plain one */
  heavyShake?: boolean;
}) {
  const [rotation, setRotation] = useState(0);
  const [phase, setPhase] = useState<SpinPhase>('idle');
  const rafRef = useRef(0);
  const lastTickRef = useRef(0);
  const lastAngleRef = useRef(0);
  const animRef = useRef({ from: 0, to: 0, start: 0, dur: 0 });
  const [pointerKick, setPointerKick] = useState(0); // peg-flex while spinning

  const colors = wheelColors(livery);
  const prices = priceWheel(paint);
  const multFor = (t: Tier) => (t === 0 ? prices.safe : t === 1 ? prices.mid : prices.risky);
  const N = paint.segmentCount;

  // spin animation whenever spinNonce changes (and result is known)
  useEffect(() => {
    if (spinNonce === 0 || resultSegment === null) return;
    const segAngle = 360 / N;
    // pointer sits at 12 o'clock; target wedge center must land there.
    const targetCenter = resultSegment * segAngle + segAngle / 2;
    const targetMod = (360 - targetCenter) % 360;
    const current = rotation;
    const currentMod = ((current % 360) + 360) % 360;
    let delta = targetMod - currentMod;
    while (delta < 0) delta += 360;
    // claw-machine wind-up: pull back 16°, then launch
    const WINDUP_DEG = 16;
    const WINDUP_MS = 130;
    // Risk is suspense. The wilder the paint, the longer the wheel takes to
    // settle and the slower the last few degrees creep past the pointer — so
    // GENTLE and WILD are not just different numbers, they feel different.
    const CREEP_FRAC = 0.04; // share of the final travel spent creeping
    const CREEP_MS = 560;
    const riskyShare = paint.tiers.filter((t) => t === 2).length / paint.segmentCount;
    const from = current - WINDUP_DEG;
    const to = from + WINDUP_DEG + 360 * 5 + delta; // windup + 5 laps + landing
    const dur = WINDUP_MS + 3000 + riskyShare * 1800 + Math.random() * 420 + CREEP_MS;

    animRef.current = { from, to, start: performance.now(), dur };
    lastAngleRef.current = current;
    setPhase('spinning');

    const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);
    const windupT = WINDUP_MS / dur;
    const mainT = 1 - CREEP_MS / dur; // the long launch ends here; the creep follows

    const step = (now: number) => {
      const a = animRef.current;
      const t = Math.min(1, (now - a.start) / a.dur);
      // three phases: reverse pull, long decelerating launch, final creep
      const p = t < windupT
        ? (-WINDUP_DEG * (1 - t / windupT)) / (a.to - a.from) // windup segment
        : t < mainT
          ? (1 - CREEP_FRAC) * easeOutQuart((t - windupT) / (mainT - windupT))
          : (1 - CREEP_FRAC) + CREEP_FRAC * ((t - mainT) / Math.max(1e-6, 1 - mainT));
      const angle = a.from + (a.to - a.from) * p;
      setRotation(angle);

      // Speed is measured from how far the rim actually moved, not from the
      // clock, so the peg ticks stay in step with the wheel all the way through
      // the slow creep — where they thin out instead of lying about the speed.
      const swept = Math.abs(angle - lastAngleRef.current);
      lastAngleRef.current = angle;
      const speed01 = Math.min(1, swept / 7);

      // pointer flexes on pegs while fast, settles as it slows
      setPointerKick(t < 1 ? Math.sin(now / 26) * 9 * speed01 * speed01 : 0);

      // one ratchet tick per peg crossing, pitch scaling with speed
      if (now - lastTickRef.current > 26 && swept > 0.4) {
        lastTickRef.current = now;
        onTickSound?.(speed01);
      }

      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        setPhase('done');
        onLand?.();
      }
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinNonce]);

  const segAngle = 360 / N;
  const cx = 200;
  const cy = 200;
  const R = 186;
  const rim = 14;

  const wedgePath = (i: number): string => {
    const a0 = ((i * segAngle - 90) * Math.PI) / 180;
    const a1 = (((i + 1) * segAngle - 90) * Math.PI) / 180;
    const x0 = cx + R * Math.cos(a0);
    const y0 = cy + R * Math.sin(a0);
    const x1 = cx + R * Math.cos(a1);
    const y1 = cy + R * Math.sin(a1);
    return `M ${cx} ${cy} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
  };

  const labelPos = (i: number): { x: number; y: number } => {
    const mid = ((i + 0.5) * segAngle - 90) * (Math.PI / 180);
    const rr = R * 0.72;
    return { x: cx + rr * Math.cos(mid), y: cy + rr * Math.sin(mid) };
  };

  return (
    <div className={`wheel-wrap${phase === 'done' ? ` spun-shake${heavyShake ? ' heavy' : ''}` : ''}`}>
      <svg className="wheel-svg" viewBox="0 0 400 400" aria-label="FAIRGROUND prize wheel">
        {/* outer rim */}
        <circle cx={cx} cy={cy} r={R + rim / 2} fill="#fffdf7" stroke="#141414" strokeWidth="5" />
        {/* fixed ink ring: the wheel is artwork, so this must not follow the
            host theme the way the page chrome does */}
        <circle cx={cx} cy={cy} r={R + rim / 2 - 7} fill="none" stroke="rgba(20, 20, 20, 0.14)" strokeWidth="2" />

        <g transform={`rotate(${rotation} ${cx} ${cy})`}>
          {paint.tiers.map((t, i) => {
            const pos = labelPos(i);
            return (
              <g
                key={i}
                onClick={interactive && onPaintSegment ? () => onPaintSegment(i) : undefined}
                style={{ cursor: interactive ? 'pointer' : 'default' }}
              >
                <path d={wedgePath(i)} fill={colors[t].fill} stroke="#141414" strokeWidth="3" />
                <text
                  x={pos.x}
                  y={pos.y}
                  fill={colors[t].text}
                  fontSize="15"
                  fontWeight="700"
                  fontFamily="var(--font-pixel)"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  transform={`rotate(${(i + 0.5) * segAngle} ${pos.x} ${pos.y})`}
                  style={{ pointerEvents: 'none' }}
                >
                  {formatMultiplier(multFor(t)).replace('×', '')}
                </text>
              </g>
            );
          })}
          {/* hub — center dot wears the livery's risky color */}
          <circle cx={cx} cy={cy} r="34" fill="#fffdf7" stroke="#141414" strokeWidth="4" />
          <circle cx={cx} cy={cy} r="10" fill={colors[2].fill} stroke="#141414" strokeWidth="2" />
        </g>

        {/* static pointer hub cap */}
        <circle cx={cx} cy={cy} r="5" fill="#e8442e" stroke="#141414" strokeWidth="2" />
      </svg>

      {/* winning wedge flash overlay */}
      {phase === 'done' && resultSegment !== null && (
        <svg className="wedge-flash" viewBox="0 0 400 400" aria-hidden>
          <path d={wedgePath(resultSegment)} fill="#ffffff" />
        </svg>
      )}

      {/* pointer at 12 o'clock — flexes while spinning */}
      <svg
        className="pointer"
        width="44" height="30" viewBox="0 0 44 30" aria-hidden
        style={{ transform: `translateX(-50%) rotate(${pointerKick.toFixed(2)}deg)`, transformOrigin: '50% 100%' }}
      >
        <path d="M22 28 L4 4 Q22 10 40 4 Z" fill="#e8442e" stroke="#141414" strokeWidth="3" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
