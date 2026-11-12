/**
 * Player progression: coins and experience earned by playing, cosmetic items bought with those
 * coins, career statistics, tournament progress and the daily challenge. Everything is stored on
 * the device; there is no real-money purchase anywhere.
 */
import type { MatchConfig } from '../rules/scoring';
import type { Difficulty } from './types';

export type ItemKind = 'racket' | 'outfit' | 'court' | 'ball';

export interface ShopItem {
  id: string;
  kind: ItemKind;
  name: string;
  /** Short line shown under the name. */
  note: string;
  price: number;
  /** Main colour (hex) used both in the game and for the shop swatch. */
  color: number;
  /** Secondary colour: shorts for outfits, frame for rackets. */
  color2?: number;
  rarity: 'standard' | 'rare' | 'épique' | 'légendaire';
}

export const CATALOG: ShopItem[] = [
  // Rackets: accent colour of the face, frame colour.
  { id: 'racket.volt', kind: 'racket', name: 'Volt', note: 'Carbone noir, arc citron', price: 0, color: 0xd8ef2f, color2: 0x14161a, rarity: 'standard' },
  { id: 'racket.blaze', kind: 'racket', name: 'Blaze', note: 'Arc orange vif', price: 300, color: 0xff7a1a, color2: 0x14161a, rarity: 'rare' },
  { id: 'racket.arctic', kind: 'racket', name: 'Arctic', note: 'Cadre blanc, arc cyan', price: 450, color: 0x35d6ff, color2: 0xe8eef2, rarity: 'rare' },
  { id: 'racket.ruby', kind: 'racket', name: 'Ruby', note: 'Cadre rouge profond', price: 700, color: 0xffffff, color2: 0x9c1422, rarity: 'épique' },
  { id: 'racket.aurum', kind: 'racket', name: 'Aurum', note: 'Finition or', price: 1500, color: 0xffd34d, color2: 0x2a2108, rarity: 'légendaire' },
  // Outfits: shirt and shorts of your pair.
  { id: 'outfit.club', kind: 'outfit', name: 'Club', note: 'Blanc et marine', price: 0, color: 0xf3f5f7, color2: 0x1b2740, rarity: 'standard' },
  { id: 'outfit.ocean', kind: 'outfit', name: 'Océan', note: 'Bleu ciel, short blanc', price: 250, color: 0x4aa8ff, color2: 0xe9edf2, rarity: 'rare' },
  { id: 'outfit.citron', kind: 'outfit', name: 'Citron', note: 'Jaune fluo, short noir', price: 400, color: 0xd8ef2f, color2: 0x15171c, rarity: 'rare' },
  { id: 'outfit.nuit', kind: 'outfit', name: 'Nuit', note: 'Noir intégral', price: 600, color: 0x1d2026, color2: 0x101216, rarity: 'épique' },
  { id: 'outfit.sunset', kind: 'outfit', name: 'Sunset', note: 'Corail, short violet', price: 900, color: 0xff6b5e, color2: 0x4a2a7a, rarity: 'épique' },
  { id: 'outfit.champion', kind: 'outfit', name: 'Champion', note: 'Or et blanc', price: 2000, color: 0xf2c230, color2: 0xf4f4f0, rarity: 'légendaire' },
  // Courts: colour of the playing surface.
  { id: 'court.bleu', kind: 'court', name: 'Bleu Tour', note: 'Le classique des circuits pro', price: 0, color: 0x1e63c8, rarity: 'standard' },
  { id: 'court.vert', kind: 'court', name: 'Vert Club', note: 'Gazon synthétique vert', price: 350, color: 0x1f8a4c, rarity: 'rare' },
  { id: 'court.violet', kind: 'court', name: 'Violet Arena', note: 'Ambiance salle de gala', price: 800, color: 0x6a3fc4, rarity: 'épique' },
  { id: 'court.terre', kind: 'court', name: 'Terre Rouge', note: 'Façon terre battue', price: 800, color: 0xb5512c, rarity: 'épique' },
  { id: 'court.noir', kind: 'court', name: 'Black Edition', note: 'Surface anthracite', price: 1800, color: 0x2c3138, rarity: 'légendaire' },
  // Balls.
  { id: 'ball.jaune', kind: 'ball', name: 'Jaune optique', note: 'La balle officielle', price: 0, color: 0xd0e828, rarity: 'standard' },
  { id: 'ball.orange', kind: 'ball', name: 'Orange', note: 'Bien visible de nuit', price: 200, color: 0xff8a1e, rarity: 'rare' },
  { id: 'ball.rose', kind: 'ball', name: 'Rose', note: 'Édition spéciale', price: 350, color: 0xff5fa8, rarity: 'rare' },
  { id: 'ball.blanche', kind: 'ball', name: 'Blanche', note: 'Rétro', price: 500, color: 0xf2f2ec, rarity: 'épique' },
];

export const itemById = (id: string): ShopItem => CATALOG.find((i) => i.id === id) ?? CATALOG[0];

export type ModeId = 'quick' | 'full' | 'tiebreak' | 'tournament' | 'training' | 'daily';

export interface GameMode {
  id: ModeId;
  name: string;
  tagline: string;
  detail: string;
  match: Partial<MatchConfig>;
  /** Fixed difficulty; null uses the one chosen by the player. */
  difficulty: Difficulty | null;
  /** Fixed assist level; null uses the player's setting. */
  assist: number | null;
  winCoins: number;
  lossCoins: number;
  winXp: number;
}

export const MODES: GameMode[] = [
  { id: 'quick', name: 'Match rapide', tagline: '1 set', detail: 'Un set, tie-break à 6-6. Environ 10 minutes.', match: { setsToWin: 1 }, difficulty: null, assist: null, winCoins: 120, lossCoins: 30, winXp: 120 },
  { id: 'full', name: 'Match complet', tagline: '2 sets gagnants', detail: 'Le format officiel : deux sets gagnants.', match: { setsToWin: 2 }, difficulty: null, assist: null, winCoins: 260, lossCoins: 60, winXp: 260 },
  { id: 'tiebreak', name: 'Tie-break', tagline: 'Premier à 7', detail: 'Un tie-break sec, deux points d’écart. Idéal pour une partie éclair.', match: { setsToWin: 1, tiebreakAt: 0 }, difficulty: null, assist: null, winCoins: 60, lossCoins: 15, winXp: 60 },
  { id: 'tournament', name: 'Tournoi', tagline: '3 tours', detail: 'Quart, demi, finale : chaque tour est plus dur. Gagnez la finale pour le trophée.', match: { setsToWin: 1 }, difficulty: 'easy', assist: null, winCoins: 150, lossCoins: 40, winXp: 180 },
  { id: 'training', name: 'Entraînement', tagline: 'Sans pression', detail: 'Adversaires faciles et aide au placement maximale pour prendre le jeu en main.', match: { setsToWin: 1 }, difficulty: 'easy', assist: 1, winCoins: 30, lossCoins: 10, winXp: 40 },
  { id: 'daily', name: 'Défi du jour', tagline: 'Bonus quotidien', detail: 'Un tie-break contre des adversaires difficiles. Une récompense par jour.', match: { setsToWin: 1, tiebreakAt: 0 }, difficulty: 'hard', assist: null, winCoins: 300, lossCoins: 20, winXp: 200 },
];

export const modeById = (id: ModeId): GameMode => MODES.find((m) => m.id === id) ?? MODES[0];

export const TOURNAMENT_ROUNDS: Array<{ name: string; difficulty: Difficulty }> = [
  { name: 'Quart de finale', difficulty: 'easy' },
  { name: 'Demi-finale', difficulty: 'medium' },
  { name: 'Finale', difficulty: 'hard' },
];
export const TOURNAMENT_TROPHY_COINS = 500;

export interface Stats {
  matches: number;
  wins: number;
  pointsWon: number;
  pointsLost: number;
  aces: number;
  winners: number;
  bestStreak: number;
  streak: number;
  trophies: number;
  longestRally: number;
}

export interface Profile {
  name: string;
  coins: number;
  xp: number;
  owned: string[];
  equipped: Record<ItemKind, string>;
  stats: Stats;
  /** Next tournament round to play: 0, 1 or 2. */
  tournamentRound: number;
  /** Local date (YYYY-MM-DD) on which the daily challenge reward was last won. */
  dailyDone: string;
  lastMode: ModeId;
}

const KEY = 'padel3d.profile.v1';

export function defaultProfile(): Profile {
  return {
    name: 'Joueur',
    coins: 200,
    xp: 0,
    owned: CATALOG.filter((i) => i.price === 0).map((i) => i.id),
    equipped: { racket: 'racket.volt', outfit: 'outfit.club', court: 'court.bleu', ball: 'ball.jaune' },
    stats: { matches: 0, wins: 0, pointsWon: 0, pointsLost: 0, aces: 0, winners: 0, bestStreak: 0, streak: 0, trophies: 0, longestRally: 0 },
    tournamentRound: 0,
    dailyDone: '',
    lastMode: 'quick',
  };
}

export function loadProfile(): Profile {
  const base = defaultProfile();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const p = JSON.parse(raw) as Partial<Profile>;
    const merged: Profile = {
      ...base,
      ...p,
      equipped: { ...base.equipped, ...(p.equipped ?? {}) },
      stats: { ...base.stats, ...(p.stats ?? {}) },
      owned: Array.from(new Set([...base.owned, ...(p.owned ?? [])])),
    };
    // Never trust stored ids blindly: an equipped item must exist and be owned.
    for (const kind of Object.keys(base.equipped) as ItemKind[]) {
      const id = merged.equipped[kind];
      if (!CATALOG.some((i) => i.id === id && i.kind === kind) || !merged.owned.includes(id)) merged.equipped[kind] = base.equipped[kind];
    }
    return merged;
  } catch {
    return base;
  }
}

export function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Storage unavailable: progress lasts for this session only.
  }
}

/** Experience needed to reach `level` from level 1. */
export const xpForLevel = (level: number): number => 150 * (level - 1) * level;

export function levelOf(xp: number): { level: number; into: number; span: number } {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  return { level, into: xp - xpForLevel(level), span: xpForLevel(level + 1) - xpForLevel(level) };
}

export const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function buyItem(p: Profile, id: string): boolean {
  const item = CATALOG.find((i) => i.id === id);
  if (!item || p.owned.includes(id) || p.coins < item.price) return false;
  p.coins -= item.price;
  p.owned.push(id);
  p.equipped[item.kind] = id;
  saveProfile(p);
  return true;
}

export function equipItem(p: Profile, id: string): boolean {
  const item = CATALOG.find((i) => i.id === id);
  if (!item || !p.owned.includes(id)) return false;
  p.equipped[item.kind] = id;
  saveProfile(p);
  return true;
}

export interface MatchSummary {
  mode: ModeId;
  won: boolean;
  pointsWon: number;
  pointsLost: number;
  aces: number;
  winners: number;
  longestRally: number;
}

export interface Rewards {
  coins: number;
  xp: number;
  levelBefore: number;
  levelAfter: number;
  /** Extra lines for the result screen (tournament progress, daily bonus…). */
  notes: string[];
}

/** Applies a finished match to the profile and returns what was earned. */
export function applyMatch(p: Profile, m: MatchSummary): Rewards {
  const mode = modeById(m.mode);
  const notes: string[] = [];
  let coins = (m.won ? mode.winCoins : mode.lossCoins) + m.pointsWon * 2 + m.aces * 5;
  let xp = (m.won ? mode.winXp : Math.round(mode.winXp * 0.3)) + m.pointsWon * 3;

  if (m.mode === 'tournament') {
    if (m.won) {
      if (p.tournamentRound >= TOURNAMENT_ROUNDS.length - 1) {
        coins += TOURNAMENT_TROPHY_COINS;
        p.stats.trophies++;
        p.tournamentRound = 0;
        notes.push(`Tournoi remporté : trophée et ${TOURNAMENT_TROPHY_COINS} pièces de prime`);
      } else {
        p.tournamentRound++;
        notes.push(`Qualifié pour : ${TOURNAMENT_ROUNDS[p.tournamentRound].name}`);
      }
    } else {
      notes.push(`Éliminé en ${TOURNAMENT_ROUNDS[p.tournamentRound].name.toLowerCase()} — le tournoi repart du début`);
      p.tournamentRound = 0;
    }
  }
  if (m.mode === 'daily') {
    if (p.dailyDone === today()) {
      // Replays are allowed but only the first win of the day pays the bonus.
      coins = m.pointsWon * 2;
      notes.push('Bonus du jour déjà obtenu');
    } else if (m.won) {
      p.dailyDone = today();
      notes.push('Défi du jour réussi');
    }
  }

  const levelBefore = levelOf(p.xp).level;
  p.coins += coins;
  p.xp += xp;
  const levelAfter = levelOf(p.xp).level;
  if (levelAfter > levelBefore) {
    const bonus = 100 * (levelAfter - levelBefore);
    p.coins += bonus;
    coins += bonus;
    notes.push(`Niveau ${levelAfter} atteint : +${bonus} pièces`);
  }
  const s = p.stats;
  s.matches++;
  if (m.won) {
    s.wins++;
    s.streak++;
    s.bestStreak = Math.max(s.bestStreak, s.streak);
  } else {
    s.streak = 0;
  }
  s.pointsWon += m.pointsWon;
  s.pointsLost += m.pointsLost;
  s.aces += m.aces;
  s.winners += m.winners;
  s.longestRally = Math.max(s.longestRally, m.longestRally);
  p.lastMode = m.mode;
  saveProfile(p);
  return { coins, xp, levelBefore, levelAfter, notes };
}
