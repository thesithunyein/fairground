// FAIRGROUND — pixel carnival prizes, drawn as crisp inline SVG (no images).
import type { ToyRarity } from '../lib/collection';

const PX = 5; // pixel size

function PixelGrid({ map, palette }: { map: string[]; palette: Record<string, string> }) {
  const w = map[0].length;
  const h = map.length;
  const rects: React.ReactNode[] = [];
  map.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const fill = palette[ch];
      if (!fill) return;
      rects.push(<rect key={`${x}-${y}`} x={x * PX} y={y * PX} width={PX} height={PX} fill={fill} />);
    });
  });
  return (
    <svg width={w * PX} height={h * PX} viewBox={`0 0 ${w * PX} ${h * PX}`} shapeRendering="crispEdges" aria-hidden>
      {rects}
    </svg>
  );
}

// palettes share a black outline channel: 'k'
const K = '#141414';

const TOY_ART: Record<string, { map: string[]; palette: Record<string, string> }> = {
  duck: {
    map: [
      '..kkk...',
      'kyyyk..k',
      'kyyykkk.',
      'kyyyyyk.',
      '.kyyyyk.',
      '..kkkk..',
    ],
    palette: { k: K, y: '#f5b301', o: '#e88a00' },
  },
  rocket: {
    map: [
      '...k...',
      '..kwwk.',
      '..kwwk.',
      '.kwoowk',
      '.kwoowk',
      'k.oo..k',
      'k.kk..k',
    ],
    palette: { k: K, w: '#f7f4ec', o: '#e8442e' },
  },
  cat: {
    map: [
      'k.k..k.k',
      'kvvkkvvk',
      'kvvvvvvk',
      'kvgvvgvk',
      'kvvvvvvk',
      '.kvkkvk.',
    ],
    palette: { k: K, v: '#8a5cd6', g: '#7dffb2' },
  },
  robot: {
    map: [
      '..kkkk..',
      '.kccccck',
      '.kcgcgck',
      '.kccccck',
      'kk....kk',
      '..kcck..',
      '..k..k..',
    ],
    palette: { k: K, c: '#5ce1ff', g: '#141414' },
  },
  balloon: {
    map: [
      '.kpppk.',
      'kpppppk',
      'kppqppk',
      'kpppppk',
      '.kpppk.',
      '...k...',
      '..k....',
    ],
    palette: { k: K, p: '#ff6bd6', q: '#ffd7f0' },
  },
  heart: {
    map: [
      '.kk.kk.',
      'krrkrrk',
      'krrrrrk',
      'krrrrrk',
      '.krrrk.',
      '..krk..',
      '...k...',
    ],
    palette: { k: K, r: '#ff4d6d' },
  },
};

const RARITY_TINT: Record<ToyRarity, string> = {
  common: 'rgba(20,20,20,0)',
  rare: 'rgba(47,107,255,0.12)',
  legendary: 'rgba(245,179,1,0.2)',
};

export function PrizeSprite({ toy, rarity, size = 34 }: { toy: number; rarity: ToyRarity; size?: number }) {
  const name = ['duck', 'rocket', 'cat', 'robot', 'balloon', 'heart'][toy] ?? 'duck';
  const art = TOY_ART[name];
  const scale = size / (art.map[0].length * PX);
  return (
    <div style={{ position: 'relative', lineHeight: 0, transform: `scale(${scale})`, transformOrigin: 'center' }}>
      <PixelGrid map={art.map} palette={art.palette} />
      <div style={{ position: 'absolute', inset: 0, background: RARITY_TINT[rarity], pointerEvents: 'none' }} />
    </div>
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
