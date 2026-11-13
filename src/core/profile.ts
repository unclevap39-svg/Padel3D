/**
 * Player progression: coins and experience earned by playing, cosmetic items bought with those
 * coins, career statistics, tournament progress and the daily challenge. Everything is stored on
 * the device; there is no real-money purchase anywhere.
 */
import type { MatchConfig } from '../rules/scoring';
import type { Difficulty } from './types';

export type ItemKind = 'character' | 'racket' | 'outfit' | 'court' | 'ball';

/** Mood of a court: surroundings and light, on top of the colour of the playing surface. */
export interface CourtTheme {
  /** Ground around the court. */
  apron: number;
  /** Tint of the advertising boards. */
  boards: number;
  /** Light bounced from above and from the ground. */
  hemi: number;
  ground: number;
  /** Colour of the floodlights. */
  key: number;
  /** Tint of the sky and of the distance haze. */
  sky: number;
  fog: number;
}

export interface ShopItem {
  id: string;
  kind: ItemKind;
  name: string;
  /** Short line shown under the name. */
  note: string;
  price: number;
  /** Main colour (hex) used both in the game and for the shop swatch. */
  color: number;
  /** Secondary colour: shorts for outfits, frame for rackets, skin tone for characters. */
  color2?: number;
  /** Characters: file of the body under models/chars (none: the base model). */
  model?: string;
  /** Rackets: outline of the head and finish of the frame. */
  shape?: 'round' | 'teardrop' | 'diamond';
  finish?: 'matte' | 'gloss' | 'metal';
  /** Courts: surroundings and light. */
  theme?: CourtTheme;
  rarity: 'standard' | 'rare' | 'épique' | 'légendaire';
}

const NIGHT: CourtTheme = { apron: 0x16233a, boards: 0xbfbfbf, hemi: 0xb4c8ee, ground: 0x1b3158, key: 0xfff6ea, sky: 0xffffff, fog: 0x0a1220 };

export const CATALOG: ShopItem[] = [
  // Characters, all invented: hair colour, skin tone (for the shop drawing), body file.
  { id: 'char.leo', kind: 'character', name: 'Léo', note: 'Le titulaire : régulier, sans point faible', price: 0, color: 0x2a1d14, color2: 0xd9a57e, model: 'leo', rarity: 'standard' },
  { id: 'char.ines', kind: 'character', name: 'Inès', note: 'Vive, queue de cheval, jeu de volée', price: 500, color: 0x6b4423, color2: 0xe3b190, model: 'ines', rarity: 'rare' },
  { id: 'char.malik', kind: 'character', name: 'Malik', note: 'Grand gabarit, frappe lourde', price: 500, color: 0x14100d, color2: 0x7a4f35, model: 'malik', rarity: 'rare' },
  { id: 'char.kenji', kind: 'character', name: 'Kenji', note: 'Léger et précis', price: 800, color: 0x0f0f12, color2: 0xdcb48f, model: 'kenji', rarity: 'rare' },
  { id: 'char.aicha', kind: 'character', name: 'Aïcha', note: 'Athlétique, tresse longue', price: 900, color: 0x1a1210, color2: 0x6e4630, model: 'aicha', rarity: 'épique' },
  { id: 'char.mei', kind: 'character', name: 'Mei', note: 'Petit format, carré noir, défense de fer', price: 900, color: 0x101014, color2: 0xe6c3a4, model: 'mei', rarity: 'épique' },
  { id: 'char.hugo', kind: 'character', name: 'Hugo', note: 'Le vétéran aux cheveux gris', price: 1200, color: 0xb9bcc0, color2: 0xd0a58a, model: 'hugo', rarity: 'épique' },
  { id: 'char.bruno', kind: 'character', name: 'Bruno', note: 'Le mur : trapu, crâne rasé', price: 1200, color: 0x2a2a2a, color2: 0xd3a788, model: 'bruno', rarity: 'épique' },
  { id: 'char.sofia', kind: 'character', name: 'Sofia', note: 'Grande, carré blond, service puissant', price: 1800, color: 0xe2c98a, color2: 0xe8bb9c, model: 'sofia', rarity: 'légendaire' },
  { id: 'char.diego', kind: 'character', name: 'Diego', note: 'Le showman aux cheveux longs', price: 1800, color: 0x3a2414, color2: 0xcf9f7f, model: 'diego', rarity: 'légendaire' },
  // Rackets: accent colour of the face, frame colour, outline of the head, finish.
  { id: 'racket.volt', kind: 'racket', name: 'Volt', note: 'Ronde, carbone noir, arc citron', price: 0, color: 0xd8ef2f, color2: 0x14161a, shape: 'round', finish: 'gloss', rarity: 'standard' },
  { id: 'racket.blaze', kind: 'racket', name: 'Blaze', note: 'Goutte d’eau, arc orange vif', price: 300, color: 0xff7a1a, color2: 0x14161a, shape: 'teardrop', finish: 'gloss', rarity: 'rare' },
  { id: 'racket.onyx', kind: 'racket', name: 'Onyx', note: 'Goutte d’eau, noir mat, arc blanc', price: 350, color: 0xf2f4f5, color2: 0x0c0d10, shape: 'teardrop', finish: 'matte', rarity: 'rare' },
  { id: 'racket.arctic', kind: 'racket', name: 'Arctic', note: 'Ronde, cadre blanc, arc cyan', price: 450, color: 0x35d6ff, color2: 0xe8eef2, shape: 'round', finish: 'gloss', rarity: 'rare' },
  { id: 'racket.lagune', kind: 'racket', name: 'Lagune', note: 'Ronde, cadre turquoise', price: 500, color: 0xffffff, color2: 0x0f8f8a, shape: 'round', finish: 'matte', rarity: 'rare' },
  { id: 'racket.ruby', kind: 'racket', name: 'Ruby', note: 'Diamant, cadre rouge profond', price: 700, color: 0xffffff, color2: 0x9c1422, shape: 'diamond', finish: 'gloss', rarity: 'épique' },
  { id: 'racket.magma', kind: 'racket', name: 'Magma', note: 'Diamant, noir mat, arc rouge', price: 900, color: 0xff3b2f, color2: 0x15110f, shape: 'diamond', finish: 'matte', rarity: 'épique' },
  { id: 'racket.chrome', kind: 'racket', name: 'Chrome', note: 'Goutte d’eau, cadre métal poli', price: 1200, color: 0x9fd8ff, color2: 0xc8ced6, shape: 'teardrop', finish: 'metal', rarity: 'épique' },
  { id: 'racket.aurum', kind: 'racket', name: 'Aurum', note: 'Diamant, finition or', price: 1500, color: 0xffd34d, color2: 0xb8892a, shape: 'diamond', finish: 'metal', rarity: 'légendaire' },
  { id: 'racket.prisme', kind: 'racket', name: 'Prisme', note: 'Diamant, violet métallisé, arc rose', price: 2000, color: 0xff6ad5, color2: 0x5a2fd0, shape: 'diamond', finish: 'metal', rarity: 'légendaire' },
  // Outfits: shirt and shorts of your pair.
  { id: 'outfit.club', kind: 'outfit', name: 'Club', note: 'Blanc et marine', price: 0, color: 0xf3f5f7, color2: 0x1b2740, rarity: 'standard' },
  { id: 'outfit.ocean', kind: 'outfit', name: 'Océan', note: 'Bleu ciel, short blanc', price: 250, color: 0x4aa8ff, color2: 0xe9edf2, rarity: 'rare' },
  { id: 'outfit.citron', kind: 'outfit', name: 'Citron', note: 'Jaune fluo, short noir', price: 400, color: 0xd8ef2f, color2: 0x15171c, rarity: 'rare' },
  { id: 'outfit.nuit', kind: 'outfit', name: 'Nuit', note: 'Noir intégral', price: 600, color: 0x1d2026, color2: 0x101216, rarity: 'épique' },
  { id: 'outfit.sunset', kind: 'outfit', name: 'Sunset', note: 'Corail, short violet', price: 900, color: 0xff6b5e, color2: 0x4a2a7a, rarity: 'épique' },
  { id: 'outfit.champion', kind: 'outfit', name: 'Champion', note: 'Or et blanc', price: 2000, color: 0xf2c230, color2: 0xf4f4f0, rarity: 'légendaire' },
  // Courts: colour of the playing surface.
  { id: 'court.bleu', kind: 'court', name: 'Bleu Tour', note: 'Le classique des circuits pro, de nuit', price: 0, color: 0x1e63c8, theme: NIGHT, rarity: 'standard' },
  { id: 'court.vert', kind: 'court', name: 'Vert Club', note: 'Gazon vert, soirée au club', price: 350, color: 0x1f8a4c, theme: { apron: 0x15301f, boards: 0x9fd0a8, hemi: 0xc9e6cf, ground: 0x1c4a2c, key: 0xfff3d6, sky: 0xd9ffe6, fog: 0x0a1a12 }, rarity: 'rare' },
  { id: 'court.sable', kind: 'court', name: 'Sable', note: 'Club de plage en fin d’après-midi', price: 450, color: 0xc79a4e, theme: { apron: 0x7a5a2c, boards: 0xffe0a8, hemi: 0xffe7c2, ground: 0x8a5a2a, key: 0xffd9a0, sky: 0xffb070, fog: 0x4a3526 }, rarity: 'rare' },
  { id: 'court.glacier', kind: 'court', name: 'Glacier', note: 'Bleu glace sous lumière froide', price: 600, color: 0x6fb6de, theme: { apron: 0x1c3550, boards: 0xd0f0ff, hemi: 0xd8f0ff, ground: 0x2a5578, key: 0xe8f6ff, sky: 0xbfe4ff, fog: 0x10263a }, rarity: 'rare' },
  { id: 'court.violet', kind: 'court', name: 'Violet Arena', note: 'Salle de gala, projecteurs mauves', price: 800, color: 0x6a3fc4, theme: { apron: 0x231640, boards: 0xd8b8ff, hemi: 0xd6c2ff, ground: 0x3a2270, key: 0xf4e8ff, sky: 0xc9a8ff, fog: 0x140c26 }, rarity: 'épique' },
  { id: 'court.terre', kind: 'court', name: 'Terre Rouge', note: 'Façon terre battue au coucher du soleil', price: 800, color: 0xb5512c, theme: { apron: 0x4a2414, boards: 0xffc9a0, hemi: 0xffd2b0, ground: 0x6a2e18, key: 0xffc48a, sky: 0xff8a5a, fog: 0x2a140e }, rarity: 'épique' },
  { id: 'court.miami', kind: 'court', name: 'Miami', note: 'Rose vif et néons turquoise', price: 1000, color: 0xd9488a, theme: { apron: 0x10343a, boards: 0x7ff0e6, hemi: 0xffc6e6, ground: 0x15565e, key: 0xfff0f6, sky: 0xff9ad0, fog: 0x1a1030 }, rarity: 'épique' },
  { id: 'court.emeraude', kind: 'court', name: 'Émeraude', note: 'Vert profond et dorures', price: 1200, color: 0x0b5a45, theme: { apron: 0x0c2a22, boards: 0xf2d27a, hemi: 0xe8e2b8, ground: 0x143a2e, key: 0xfff0c8, sky: 0xf2e6b0, fog: 0x08140f }, rarity: 'épique' },
  { id: 'court.noir', kind: 'court', name: 'Black Edition', note: 'Anthracite sous lumière blanche', price: 1800, color: 0x2c3138, theme: { apron: 0x0b0d10, boards: 0xffffff, hemi: 0xe6ebf2, ground: 0x15181d, key: 0xffffff, sky: 0x8a94a6, fog: 0x05070a }, rarity: 'légendaire' },
  { id: 'court.neon', kind: 'court', name: 'Néon', note: 'Bleu nuit, lumière cyan électrique', price: 2200, color: 0x121c46, theme: { apron: 0x05081a, boards: 0x6ff6ff, hemi: 0x7fe8ff, ground: 0x10206a, key: 0xcff6ff, sky: 0x5fd8ff, fog: 0x03061a }, rarity: 'légendaire' },
  // Balls.
  { id: 'ball.jaune', kind: 'ball', name: 'Jaune optique', note: 'La balle officielle', price: 0, color: 0xd0e828, rarity: 'standard' },
  { id: 'ball.orange', kind: 'ball', name: 'Orange', note: 'Bien visible de nuit', price: 200, color: 0xff8a1e, rarity: 'rare' },
  { id: 'ball.rose', kind: 'ball', name: 'Rose', note: 'Édition spéciale', price: 350, color: 0xff5fa8, rarity: 'rare' },
  { id: 'ball.blanche', kind: 'ball', name: 'Blanche', note: 'Rétro', price: 500, color: 0xf2f2ec, rarity: 'épique' },
];

export const itemById = (id: string): ShopItem => CATALOG.find((i) => i.id === id) ?? CATALOG[0];

export type ModeId = 'quick' | 'full' | 'tiebreak' | 'tournament' | 'training' | 'daily' | 'online' | 'ranked';

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
  /** Not offered in the list of solo modes (online matches). */
  hidden?: boolean;
}

export const MODES: GameMode[] = [
  { id: 'quick', name: 'Match rapide', tagline: '1 set', detail: 'Un set, tie-break à 6-6. Environ 10 minutes.', match: { setsToWin: 1 }, difficulty: null, assist: null, winCoins: 120, lossCoins: 30, winXp: 120 },
  { id: 'full', name: 'Match complet', tagline: '2 sets gagnants', detail: 'Le format officiel : deux sets gagnants.', match: { setsToWin: 2 }, difficulty: null, assist: null, winCoins: 260, lossCoins: 60, winXp: 260 },
  { id: 'tiebreak', name: 'Tie-break', tagline: 'Premier à 7', detail: 'Un tie-break sec, deux points d’écart. Idéal pour une partie éclair.', match: { setsToWin: 1, tiebreakAt: 0 }, difficulty: null, assist: null, winCoins: 60, lossCoins: 15, winXp: 60 },
  { id: 'tournament', name: 'Tournoi', tagline: '3 tours', detail: 'Quart, demi, finale : chaque tour est plus dur. Gagnez la finale pour le trophée.', match: { setsToWin: 1 }, difficulty: 'easy', assist: null, winCoins: 150, lossCoins: 40, winXp: 180 },
  { id: 'training', name: 'Entraînement', tagline: 'Sans pression', detail: 'Adversaires faciles et aide au placement maximale pour prendre le jeu en main.', match: { setsToWin: 1 }, difficulty: 'easy', assist: 1, winCoins: 30, lossCoins: 10, winXp: 40 },
  { id: 'online', name: 'Match en ligne', tagline: 'Classique', detail: 'Un set contre un autre joueur.', match: { setsToWin: 1 }, difficulty: 'medium', assist: null, winCoins: 100, lossCoins: 30, winXp: 120, hidden: true },
  { id: 'ranked', name: 'Match classé', tagline: 'Classé', detail: 'Un set contre un autre joueur, avec points de classement.', match: { setsToWin: 1 }, difficulty: 'medium', assist: null, winCoins: 150, lossCoins: 40, winXp: 160, hidden: true },
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
  /** Solo matches: doubles with an AI partner, or one against one. */
  format: 'double' | 'single';
}

const KEY = 'padel3d.profile.v1';

export function defaultProfile(): Profile {
  return {
    name: 'Joueur',
    coins: 200,
    xp: 0,
    owned: CATALOG.filter((i) => i.price === 0).map((i) => i.id),
    equipped: { character: 'char.leo', racket: 'racket.volt', outfit: 'outfit.club', court: 'court.bleu', ball: 'ball.jaune' },
    stats: { matches: 0, wins: 0, pointsWon: 0, pointsLost: 0, aces: 0, winners: 0, bestStreak: 0, streak: 0, trophies: 0, longestRally: 0 },
    tournamentRound: 0,
    dailyDone: '',
    lastMode: 'quick',
    format: 'double',
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
    if (!MODES.some((m) => m.id === merged.lastMode && !m.hidden)) merged.lastMode = 'quick';
    if (merged.format !== 'single') merged.format = 'double';
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
  if (!mode.hidden) p.lastMode = m.mode;
  saveProfile(p);
  return { coins, xp, levelBefore, levelAfter, notes };
}
