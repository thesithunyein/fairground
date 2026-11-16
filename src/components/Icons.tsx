// FAIRGROUND's own icon set: small glossy SVGs in the game's palette, so the
// interface looks the same on every device instead of borrowing system emoji.
import type { ReactNode } from 'react';

function Svg({ size = 22, children }: { size?: number; children: ReactNode }) {
  return (
    <svg className="fg-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

const SHINE = 'rgba(255,255,255,0.55)';

/** Play: the prize wheel. */
export function IconWheel({ size }: { size?: number }) {
  const cols = ['#ff4f7b', '#22c93a', '#ffc21a', '#22c93a', '#ff4f7b', '#ffc21a'];
  return (
    <Svg size={size}>
      <circle cx="12" cy="12.5" r="10" fill="#bfe8ff" />
      {cols.map((fill, i) => {
        const a0 = ((i * 60 - 90) * Math.PI) / 180;
        const a1 = (((i + 1) * 60 - 90) * Math.PI) / 180;
        const r = 8.4;
        return (
          <path
            key={i}
            d={`M12 12.5 L${(12 + r * Math.cos(a0)).toFixed(2)} ${(12.5 + r * Math.sin(a0)).toFixed(2)} A${r} ${r} 0 0 1 ${(12 + r * Math.cos(a1)).toFixed(2)} ${(12.5 + r * Math.sin(a1)).toFixed(2)} Z`}
            fill={fill}
            stroke="#fff"
            strokeWidth="0.9"
            strokeLinejoin="round"
          />
        );
      })}
      <circle cx="12" cy="12.5" r="2.3" fill="#fff" />
      <path d="M12 5.4 L9.9 1.6 Q12 2.5 14.1 1.6 Z" fill="#ffb300" stroke="#fff" strokeWidth="0.9" strokeLinejoin="round" />
    </Svg>
  );
}

/** Collect: a prize gem. */
export function IconGem({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M6.2 3.5 H17.8 L22 9.2 L12 21.5 L2 9.2 Z" fill="#ff8a1f" stroke="#fff" strokeWidth="1" strokeLinejoin="round" />
      <path d="M6.2 3.5 H17.8 L22 9.2 H2 Z" fill="#ffc21a" />
      <path d="M8.6 9.2 L12 3.5 L15.4 9.2 L12 21.5 Z" fill="#ffd95a" opacity="0.85" />
      <path d="M6.6 5 L9 5 L7.4 8 L4.6 8 Z" fill={SHINE} />
    </Svg>
  );
}

/** Daily: a ticket with a star punched in it. */
export function IconTicket({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path
        d="M3 6.5 a2 2 0 0 1 2 -2 H19 a2 2 0 0 1 2 2 V9.6 a2.4 2.4 0 0 0 0 4.8 V17.5 a2 2 0 0 1 -2 2 H5 a2 2 0 0 1 -2 -2 V14.4 a2.4 2.4 0 0 0 0 -4.8 Z"
        fill="#ff4f7b"
        stroke="#fff"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <path d="M12 7.6 L13.3 10.4 L16.3 10.7 L14 12.7 L14.7 15.7 L12 14.1 L9.3 15.7 L10 12.7 L7.7 10.7 L10.7 10.4 Z" fill="#fff" />
      <path d="M5.4 6 H11 L10 7.6 H5 Z" fill={SHINE} opacity="0.6" />
    </Svg>
  );
}

/** Shuffle: a die. */
export function IconDice({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="3" y="3" width="18" height="18" rx="5" fill="#2f80ff" stroke="#fff" strokeWidth="1" />
      <rect x="4.6" y="4.4" width="9" height="3.4" rx="1.7" fill={SHINE} opacity="0.5" />
      {[[8, 8], [16, 8], [12, 12], [8, 16], [16, 16]].map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="1.7" fill="#fff" />
      ))}
    </Svg>
  );
}

/** Share: an arrow leaving a tray. */
export function IconShare({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M12 15 V4.5 M12 4.5 L7.8 8.7 M12 4.5 L16.2 8.7" fill="none" stroke="#2f80ff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 13.5 V17.5 a2 2 0 0 0 2 2 H17 a2 2 0 0 0 2 -2 V13.5" fill="none" stroke="#2f80ff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/** Slices: a pie with one wedge pulled out. */
export function IconSlices({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M11 4 A9 9 0 1 0 20 13 H11 Z" fill="#22c93a" stroke="#fff" strokeWidth="1" strokeLinejoin="round" />
      <path d="M13.5 2 A8.5 8.5 0 0 1 22 10.5 H13.5 Z" fill="#ffc21a" stroke="#fff" strokeWidth="1" strokeLinejoin="round" />
    </Svg>
  );
}

/** Sound on / off. */
export function IconSound({ muted, size }: { muted: boolean; size?: number }) {
  return (
    <Svg size={size}>
      <path d="M3.5 9.5 H7.5 L12.5 5 V19 L7.5 14.5 H3.5 Z" fill="#2f80ff" stroke="#2f80ff" strokeWidth="1.6" strokeLinejoin="round" />
      {muted ? (
        <path d="M16 9.5 L21 14.5 M21 9.5 L16 14.5" fill="none" stroke="#ff4f7b" strokeWidth="2.4" strokeLinecap="round" />
      ) : (
        <>
          <path d="M15.6 9.2 a4 4 0 0 1 0 5.6" fill="none" stroke="#2f80ff" strokeWidth="2.2" strokeLinecap="round" />
          <path d="M18.3 6.6 a7.6 7.6 0 0 1 0 10.8" fill="none" stroke="#2f80ff" strokeWidth="2.2" strokeLinecap="round" opacity="0.55" />
        </>
      )}
    </Svg>
  );
}

/** Help. */
export function IconHelp({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M8.2 9 a3.8 3.8 0 1 1 5.6 3.3 c-1.2 0.7 -1.8 1.4 -1.8 2.7" fill="none" stroke="#2f80ff" strokeWidth="2.8" strokeLinecap="round" />
      <circle cx="12" cy="19.2" r="1.8" fill="#2f80ff" />
    </Svg>
  );
}

/** Check mark. */
export function IconCheck({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M5 12.5 L10 17.5 L19.5 7" fill="none" stroke="#22c93a" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/** Padlock for a livery that is still locked. */
export function IconLock({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M8 11 V8 a4 4 0 0 1 8 0 V11" fill="none" stroke="#9fb4d9" strokeWidth="2.4" strokeLinecap="round" />
      <rect x="5" y="10.5" width="14" height="10.5" rx="3" fill="#ffc21a" stroke="#fff" strokeWidth="1" />
      <circle cx="12" cy="15.6" r="1.7" fill="#6b3d00" />
    </Svg>
  );
}

/** Close. */
export function IconClose({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M6.5 6.5 L17.5 17.5 M17.5 6.5 L6.5 17.5" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
    </Svg>
  );
}

/** Coin faces for the ride. */
export function IconStar({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M12 2.5 L14.9 8.6 L21.5 9.4 L16.6 13.9 L17.9 20.5 L12 17.2 L6.1 20.5 L7.4 13.9 L2.5 9.4 L9.1 8.6 Z" fill="#fff" stroke="#fff" strokeWidth="1" strokeLinejoin="round" />
    </Svg>
  );
}
