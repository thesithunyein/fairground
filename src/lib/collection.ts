// FAIRGROUND — prize collection meta (localStorage, no accounts).
// 6 carnival toys × 3 rarities = 18 collectibles. Sets unlock booth liveries.

export type ToyRarity = 'common' | 'rare' | 'legendary';

export const TOY_NAMES = ['duck', 'rocket', 'cat', 'robot', 'balloon', 'heart'] as const;
export type ToyId = (typeof TOY_NAMES)[number];

export const RARITIES: ToyRarity[] = ['common', 'rare', 'legendary'];

export type Collection = {
  /** key `${toyId}:${rarity}` → owned count */
  counts: Record<string, number>;
  activeLivery: string;
  /** trophies earned outside the sets, currently the mission ladder's gilded wheel */
  trophies: string[];
  /** ids → YYYY-MM-DD, the first time a set or the album was completed */
  stamps: Record<string, string>;
};

const KEY = 'fairground.collection.v1';

export const EMPTY: Collection = { counts: {}, activeLivery: 'classic', trophies: [], stamps: {} };

export function loadCollection(): Collection {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY, counts: {}, trophies: [], stamps: {} };
    const parsed = JSON.parse(raw) as Partial<Collection>;
    return {
      counts: typeof parsed.counts === 'object' && parsed.counts ? parsed.counts : {},
      activeLivery: typeof parsed.activeLivery === 'string' ? parsed.activeLivery : 'classic',
      trophies: Array.isArray(parsed.trophies) ? parsed.trophies : [],
      stamps: typeof parsed.stamps === 'object' && parsed.stamps ? parsed.stamps : {},
    };
  } catch {
    return { ...EMPTY, counts: {}, trophies: [], stamps: {} };
  }
}

export function saveCollection(c: Collection): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* private mode — collection won't persist, game still works */
  }
}

export function prizeKey(toyIndex: number, rarity: ToyRarity): string {
  return `${TOY_NAMES[toyIndex] ?? 'duck'}:${rarity}`;
}

export function addToCollection(c: Collection, toyIndex: number, rarity: ToyRarity): { next: Collection; isNew: boolean } {
  const k = prizeKey(toyIndex, rarity);
  const isNew = !c.counts[k];
  const next: Collection = {
    ...c,
    counts: { ...c.counts, [k]: (c.counts[k] ?? 0) + 1 },
  };
  return { next, isNew };
}

// ── the album: three sets of six, one per rarity ─────────────────────────────
// Each set carries a booth livery, the album itself carries a season stamp.

export type PrizeSet = {
  id: string;
  label: string;
  rarity: ToyRarity;
  rewardLivery: string;
  rewardLabel: string;
};

export const SETS: PrizeSet[] = [
  { id: 'midway', label: 'Midway Set', rarity: 'common', rewardLivery: 'midway', rewardLabel: 'Midway livery' },
  { id: 'backstage', label: 'Backstage Set', rarity: 'rare', rewardLivery: 'mint', rewardLabel: 'Mint livery' },
  { id: 'honour', label: 'Ring of Honour', rarity: 'legendary', rewardLivery: 'twilight', rewardLabel: 'Twilight livery' },
];

export function setProgress(c: Collection, rarity: ToyRarity): { have: number; total: number; done: boolean } {
  const have = TOY_NAMES.filter((name) => (c.counts[`${name}:${rarity}`] ?? 0) > 0).length;
  return { have, total: TOY_NAMES.length, done: have === TOY_NAMES.length };
}

export function albumProgress(c: Collection): {
  sets: { set: PrizeSet; have: number; total: number; done: boolean }[];
  have: number;
  total: number;
  complete: boolean;
} {
  const sets = SETS.map((set) => ({ set, ...setProgress(c, set.rarity) }));
  const have = sets.reduce((acc, s) => acc + s.have, 0);
  const total = sets.reduce((acc, s) => acc + s.total, 0);
  return { sets, have, total, complete: have === total };
}

/** Record the first date a set or the album was finished. */
export function withStamp(c: Collection, id: string, dayKey: string): Collection {
  if (c.stamps[id]) return c;
  return { ...c, stamps: { ...c.stamps, [id]: dayKey } };
}

/** Grant a trophy once. Used by the mission ladder's seventh rung. */
export function withTrophy(c: Collection, id: string): Collection {
  if (c.trophies.includes(id)) return c;
  return { ...c, trophies: [...c.trophies, id] };
}

// ── liveries: unlocked by completing rarity sets, plus the ladder trophy ────
// classic is default; midway = all 6 commons; mint = all 6 rares;
// twilight = all 6 legendaries (the flex); gilded = seven days of missions.

export type Livery = { id: string; label: string; unlockHint: string };

export const LIVERIES: Livery[] = [
  { id: 'classic', label: 'Classic', unlockHint: 'default' },
  { id: 'midway', label: 'Midway', unlockHint: 'collect all 6 common prizes' },
  { id: 'mint', label: 'Mint', unlockHint: 'collect all 6 rare prizes' },
  { id: 'twilight', label: 'Twilight', unlockHint: 'collect all 6 legendary prizes' },
  { id: 'gilded', label: 'Gilded', unlockHint: 'bank seven days of missions' },
];

export function unlockedLiveries(c: Collection): Set<string> {
  const unlocked = new Set<string>(['classic']);
  const hasAll = (rarity: ToyRarity) =>
    TOY_NAMES.every((name) => (c.counts[`${name}:${rarity}`] ?? 0) > 0);
  if (hasAll('common')) unlocked.add('midway');
  if (hasAll('rare')) unlocked.add('mint');
  if (hasAll('legendary')) unlocked.add('twilight');
  if ((c.trophies ?? []).includes('gilded')) unlocked.add('gilded');
  return unlocked;
}

export function shelfStats(c: Collection): { owned: number; total: number } {
  const owned = RARITIES.reduce(
    (acc, r) => acc + TOY_NAMES.filter((n) => (c.counts[`${n}:${r}`] ?? 0) > 0).length,
    0,
  );
  return { owned, total: TOY_NAMES.length * RARITIES.length };
}
