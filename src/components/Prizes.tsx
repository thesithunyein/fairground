// FAIRGROUND prizes: six glossy carnival toys drawn as inline SVG (no images).
import type { ReactNode } from 'react';
import type { ToyRarity } from '../lib/collection';

const W = '#ffffff';
const SHINE = 'rgba(255,255,255,0.6)';

const TOYS: Record<string, ReactNode> = {
  duck: (
    <>
      <ellipse cx="19" cy="27" rx="13" ry="9" fill="#ffc21a" />
      <circle cx="26" cy="15" r="8.5" fill="#ffd23c" />
      <path d="M33 14 L39 16.5 L33 19 Z" fill="#ff8a1f" />
      <circle cx="28" cy="13" r="1.6" fill="#163f9e" />
      <path d="M8 26 Q14 20 20 26 Q14 31 8 26 Z" fill="#ffb300" />
      <ellipse cx="23" cy="11" rx="3" ry="1.6" fill={SHINE} />
    </>
  ),
  rocket: (
    <>
      <path d="M20 3 C28 9 29 20 26 29 H14 C11 20 12 9 20 3 Z" fill={W} />
      <path d="M20 3 C24 6 26 10 27 14 H13 C14 10 16 6 20 3 Z" fill="#ff4f7b" />
      <circle cx="20" cy="19" r="4" fill="#2f80ff" stroke="#bfe8ff" strokeWidth="1.5" />
      <path d="M14 24 L7 32 L14 30 Z M26 24 L33 32 L26 30 Z" fill="#ff4f7b" />
      <path d="M16 30 Q20 40 24 30 Z" fill="#ffc21a" />
    </>
  ),
  cat: (
    <>
      <path d="M8 6 L15 13 H25 L32 6 L33 20 C33 29 27 34 20 34 C13 34 7 29 7 20 Z" fill="#a274ff" />
      <path d="M10 9 L14 13.5 L10.5 15 Z M30 9 L26 13.5 L29.5 15 Z" fill="#ffb3d1" />
      <ellipse cx="14.5" cy="21" rx="2" ry="2.6" fill="#163f9e" />
      <ellipse cx="25.5" cy="21" rx="2" ry="2.6" fill="#163f9e" />
      <path d="M18.5 25.5 H21.5 L20 27.3 Z" fill="#ffb3d1" />
      <ellipse cx="14" cy="16" rx="3.4" ry="1.5" fill={SHINE} opacity="0.6" />
    </>
  ),
  robot: (
    <>
      <path d="M20 3 V8" stroke="#9fb4d9" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="20" cy="3.5" r="2.4" fill="#ff4f7b" />
      <rect x="7" y="8" width="26" height="20" rx="7" fill="#4fd1ff" />
      <rect x="11" y="13" width="18" height="9" rx="4.5" fill="#163f9e" />
      <circle cx="16" cy="17.5" r="2.2" fill="#7df05a" />
      <circle cx="24" cy="17.5" r="2.2" fill="#7df05a" />
      <rect x="13" y="29" width="14" height="8" rx="3" fill="#2f80ff" />
      <rect x="10" y="10" width="10" height="2.6" rx="1.3" fill={SHINE} />
    </>
  ),
  balloon: (
    <>
      <path d="M20 31 Q16 34 21 38" fill="none" stroke="#9fb4d9" strokeWidth="1.8" strokeLinecap="round" />
      <ellipse cx="20" cy="16" rx="12" ry="14" fill="#ff5fc8" />
      <path d="M17.5 29.5 H22.5 L20 33 Z" fill="#e23aa8" />
      <ellipse cx="15" cy="10" rx="3.2" ry="5" fill={SHINE} transform="rotate(-24 15 10)" />
    </>
  ),
  heart: (
    <>
      <path d="M20 35 C6 25 3 17 6 11 C9 5 17 5 20 12 C23 5 31 5 34 11 C37 17 34 25 20 35 Z" fill="#ff4f7b" />
      <ellipse cx="12.5" cy="12.5" rx="3.6" ry="2.2" fill={SHINE} transform="rotate(-30 12.5 12.5)" />
    </>
  ),
};

const TOY_ORDER = ['duck', 'rocket', 'cat', 'robot', 'balloon', 'heart'];

/** One prize. Rare gets a blue sparkle, legendary a gold glow and a sparkle. */
export function PrizeSprite({ toy, rarity, size = 34 }: { toy: number; rarity: ToyRarity; size?: number }) {
  const name = TOY_ORDER[toy] ?? 'duck';
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden style={{ display: 'block' }}>
      {rarity === 'legendary' && <circle cx="20" cy="20" r="19" fill="#ffc21a" opacity="0.28" />}
      {TOYS[name]}
      {rarity !== 'common' && (
        <path
          d="M34 2 Q34 6 38 6 Q34 6 34 10 Q34 6 30 6 Q34 6 34 2 Z"
          fill={rarity === 'legendary' ? '#ffb300' : '#2f80ff'}
          stroke="#fff"
          strokeWidth="0.8"
        />
      )}
    </svg>
  );
}

const BADGE_COLORS = ['#ff4f7b', '#22c93a', '#ffc21a', '#22c93a', '#ff4f7b', '#22c93a', '#ffc21a', '#22c93a'];

function BadgeWedges({ r, strokeWidth }: { r: number; strokeWidth: number }) {
  return (
    <>
      {BADGE_COLORS.map((fill, i) => {
        const a0 = ((i * 45 - 90) * Math.PI) / 180;
        const a1 = (((i + 1) * 45 - 90) * Math.PI) / 180;
        return (
          <path
            key={i}
            d={`M16 16 L${(16 + r * Math.cos(a0)).toFixed(2)} ${(16 + r * Math.sin(a0)).toFixed(2)} A${r} ${r} 0 0 1 ${(16 + r * Math.cos(a1)).toFixed(2)} ${(16 + r * Math.sin(a1)).toFixed(2)} Z`}
            fill={fill}
            stroke="#ffffff"
            strokeWidth={strokeWidth}
            strokeLinejoin="round"
          />
        );
      })}
    </>
  );
}

export function WheelBadge() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
      <circle cx="16" cy="16" r="15" fill="#bfe8ff" stroke="#ffffff" strokeWidth="1.6" />
      <BadgeWedges r={13} strokeWidth={1.1} />
      <circle cx="16" cy="16" r="3.4" fill="#ffffff" />
      <circle cx="16" cy="16" r="1.6" fill="#22c93a" />
    </svg>
  );
}

export function BootWheel() {
  return (
    <svg className="wheel-spin" viewBox="0 0 32 32" aria-hidden>
      <circle cx="16" cy="16" r="15" fill="#bfe8ff" stroke="#ffffff" strokeWidth="1.6" />
      <BadgeWedges r={13} strokeWidth={0.9} />
      <circle cx="16" cy="16" r="3.4" fill="#ffffff" />
      <circle cx="16" cy="16" r="1.6" fill="#22c93a" />
    </svg>
  );
}
