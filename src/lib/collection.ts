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
};

const KEY = 'fairground.collection.v1';

const EMPTY: Collection = { counts: {}, activeLivery: 'classic' };

export function loadCollection(): Collection {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY, counts: {} };
    const parsed = JSON.parse(raw) as Collection;
    return {
      counts: typeof parsed.counts === 'object' && parsed.counts ? parsed.counts : {},
      activeLivery: typeof parsed.activeLivery === 'string' ? parsed.activeLivery : 'classic',
    };
  } catch {
    return { ...EMPTY, counts: {} };
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

// ── liveries: unlocked by completing rarity sets ────────────────────────────
// classic is default; midway = all 6 commons; mint = all 6 rares;
// twilight = all 6 legendaries (the flex).

export type Livery = { id: string; label: string; unlockHint: string };

export const LIVERIES: Livery[] = [
  { id: 'classic', label: 'Classic', unlockHint: 'default' },
  { id: 'midway', label: 'Midway', unlockHint: 'collect all 6 common prizes' },
  { id: 'mint', label: 'Mint', unlockHint: 'collect all 6 rare prizes' },
  { id: 'twilight', label: 'Twilight', unlockHint: 'collect all 6 legendary prizes' },
];

export function unlockedLiveries(c: Collection): Set<string> {
  const unlocked = new Set<string>(['classic']);
  const hasAll = (rarity: ToyRarity) =>
    TOY_NAMES.every((name) => (c.counts[`${name}:${rarity}`] ?? 0) > 0);
  if (hasAll('common')) unlocked.add('midway');
  if (hasAll('rare')) unlocked.add('mint');
  if (hasAll('legendary')) unlocked.add('twilight');
  return unlocked;
}

export function shelfStats(c: Collection): { owned: number; total: number } {
  const owned = RARITIES.reduce(
    (acc, r) => acc + TOY_NAMES.filter((n) => (c.counts[`${n}:${r}`] ?? 0) > 0).length,
    0,
  );
  return { owned, total: TOY_NAMES.length * RARITIES.length };
}
