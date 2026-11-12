import type { Link } from './protocol';
import { createAnswer, createOffer, rtcSupported } from './rtc';

export type QueueMode = 'c1' | 'r1' | 'c2' | 'r2';
export type OnlineMode = QueueMode | 'i1' | 'i2';

export interface OnlineProfile {
  name: string;
  r1: number;
  r2: number;
  w1: number;
  l1: number;
  w2: number;
  l2: number;
}

export interface MatchInfo {
  matchId: string;
  role: 'host' | 'guest';
  mode: OnlineMode;
  opponent: { name: string; elo: number };
}

export type LobbyState =
  | { kind: 'idle' }
  | { kind: 'searching'; mode: QueueMode; since: number }
  | { kind: 'hosting'; code: string; mode: 'i1' | 'i2' }
  | { kind: 'joining'; code: string }
  | { kind: 'connecting'; opponent: string }
  | { kind: 'error'; message: string };

export interface LeaderRow {
  name: string;
  rating: number;
  wins: number;
  losses: number;
}

const KEY = 'padel3d.online.v1';
const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

function randomId(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

const ERRORS: Record<string, string> = {
  room_not_found: 'Ce code est inconnu ou a expiré.',
  room_full: 'Cette partie a déjà son adversaire.',
  own_room: 'C’est votre propre code : envoyez-le à un ami.',
  bad_code: 'Le code compte 5 caractères.',
  offline: 'Pas de connexion au serveur.',
  no_webrtc: 'Ce navigateur ne permet pas le jeu en ligne.',
  connect_failed: 'Connexion directe impossible entre vos deux appareils. Réessayez, si possible en Wi-Fi.',
};

/**
 * Client of the online lobby: identity, matchmaking, invitations, and the connection handshake
 * that ends with a direct link to the other player.
 */
export class Lobby {
  state: LobbyState = { kind: 'idle' };
  profile: OnlineProfile | null = null;
  onState: (s: LobbyState) => void = () => {};
  onMatch: (info: MatchInfo, link: Link) => void = () => {};
  private id: string;
  private secret: string;
  private name = 'Joueur';
  /** Bumped to abandon whatever search or handshake is in progress. */
  private epoch = 0;
  private ticket: { mode: QueueMode; ticket: string } | null = null;

  constructor() {
    let saved: { id?: string; secret?: string } = {};
    try {
      saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    } catch {
      // fresh identity below
    }
    this.id = saved.id && /^[a-z0-9-]{8,40}$/.test(saved.id) ? saved.id : randomId(20);
    this.secret = saved.secret && saved.secret.length >= 16 ? saved.secret : randomId(40);
    try {
      localStorage.setItem(KEY, JSON.stringify({ id: this.id, secret: this.secret }));
    } catch {
      // The identity then lasts for this visit only.
    }
  }

  private async call<T>(body: Record<string, unknown>): Promise<T & { error?: string }> {
    let res: Response;
    try {
      res = await fetch('/api/online', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: this.id, secret: this.secret, ...body }),
      });
    } catch {
      return { error: 'offline' } as T & { error: string };
    }
    try {
      return (await res.json()) as T & { error?: string };
    } catch {
      return { error: 'offline' } as T & { error: string };
    }
  }

  private set(state: LobbyState): void {
    this.state = state;
    this.onState(state);
  }

  private error(code: string): void {
    this.set({ kind: 'error', message: ERRORS[code] ?? 'Le service en ligne ne répond pas. Réessayez dans un instant.' });
  }

  /** Registers (or refreshes) this device with the server. */
  async hello(name: string): Promise<OnlineProfile | null> {
    this.name = name;
    const r = await this.call<{ profile: OnlineProfile }>({ op: 'hello', name });
    if (r.profile) this.profile = r.profile;
    return this.profile;
  }

  /** Ensures the server knows us before any other request. */
  private async ensure(): Promise<boolean> {
    if (!rtcSupported()) {
      this.error('no_webrtc');
      return false;
    }
    if (this.profile) return true;
    if (await this.hello(this.name)) return true;
    this.error('offline');
    return false;
  }

  async search(mode: QueueMode): Promise<void> {
    const epoch = ++this.epoch;
    this.set({ kind: 'searching', mode, since: Date.now() });
    if (!(await this.ensure())) return;
    let ticket: string | undefined;
    while (epoch === this.epoch) {
      const r = await this.call<{ state: string; ticket?: string } & Partial<MatchInfo>>({ op: 'queue', mode, ticket });
      if (epoch !== this.epoch) return;
      if (r.error) return this.error(r.error);
      if (r.state === 'matched' && r.matchId && r.role && r.opponent) {
        this.ticket = null;
        return this.connect({ matchId: r.matchId, role: r.role, mode, opponent: r.opponent }, epoch);
      }
      ticket = r.ticket ?? ticket;
      if (ticket) this.ticket = { mode, ticket };
      await wait(1500);
    }
  }

  async createRoom(kind: '1' | '2'): Promise<void> {
    const epoch = ++this.epoch;
    this.set({ kind: 'connecting', opponent: '' });
    if (!(await this.ensure())) return;
    const r = await this.call<{ code: string }>({ op: 'room-create', kind });
    if (epoch !== this.epoch) return;
    if (r.error || !r.code) return this.error(r.error ?? 'offline');
    const mode = kind === '1' ? 'i1' : 'i2';
    this.set({ kind: 'hosting', code: r.code, mode });
    while (epoch === this.epoch) {
      await wait(1500);
      const p = await this.call<{ state: string } & Partial<MatchInfo>>({ op: 'room-poll', code: r.code });
      if (epoch !== this.epoch) return;
      if (p.error) return this.error(p.error);
      if (p.state === 'matched' && p.matchId && p.opponent) {
        return this.connect({ matchId: p.matchId, role: 'host', mode, opponent: p.opponent }, epoch);
      }
    }
  }

  async joinRoom(code: string): Promise<void> {
    const epoch = ++this.epoch;
    const clean = code.trim().toUpperCase();
    this.set({ kind: 'joining', code: clean });
    if (!(await this.ensure())) return;
    const r = await this.call<{ state: string; mode?: OnlineMode } & Partial<MatchInfo>>({ op: 'room-join', code: clean });
    if (epoch !== this.epoch) return;
    if (r.error || !r.matchId || !r.opponent || !r.mode) return this.error(r.error ?? 'offline');
    return this.connect({ matchId: r.matchId, role: 'guest', mode: r.mode, opponent: r.opponent }, epoch);
  }

  /** Stops searching, hosting or connecting. */
  cancel(): void {
    this.epoch++;
    if (this.ticket) {
      void this.call({ op: 'cancel', mode: this.ticket.mode, ticket: this.ticket.ticket });
      this.ticket = null;
    }
    this.set({ kind: 'idle' });
  }

  /** Exchanges the connection offer and answer through the server, then hands over the link. */
  private async connect(info: MatchInfo, epoch: number): Promise<void> {
    this.set({ kind: 'connecting', opponent: info.opponent.name });
    const poll = async (kind: 'offer' | 'answer'): Promise<string | null> => {
      for (let i = 0; i < 40 && epoch === this.epoch; i++) {
        const r = await this.call<{ sdp: string | null }>({ op: 'signal-get', matchId: info.matchId, kind });
        if (r.sdp) return r.sdp;
        await wait(700);
      }
      return null;
    };
    try {
      let link: Link & { ready: Promise<void> };
      if (info.role === 'host') {
        const offer = await createOffer();
        link = offer.link;
        await this.call({ op: 'signal-put', matchId: info.matchId, kind: 'offer', sdp: offer.sdp });
        const answer = await poll('answer');
        if (!answer) throw new Error('no answer');
        await offer.accept(answer);
      } else {
        const offer = await poll('offer');
        if (!offer) throw new Error('no offer');
        const answer = await createAnswer(offer);
        link = answer.link;
        await this.call({ op: 'signal-put', matchId: info.matchId, kind: 'answer', sdp: answer.sdp });
      }
      await Promise.race([link.ready, wait(15000).then(() => Promise.reject(new Error('timeout')))]);
      if (epoch !== this.epoch) {
        link.close();
        return;
      }
      this.epoch++;
      this.set({ kind: 'idle' });
      this.onMatch(info, link);
    } catch {
      if (epoch === this.epoch) this.error('connect_failed');
    }
  }

  /**
   * Reports the result of a ranked match. The server waits for both players to agree; if the
   * other one left, a second report half a minute later settles it.
   */
  async reportResult(matchId: string, winner: 'host' | 'guest'): Promise<{ rating: number; delta: number } | null> {
    for (const delay of [0, 2500, 6000, 33000]) {
      await wait(delay);
      const r = await this.call<{ ranked?: boolean; state?: string; rating?: number; delta?: number }>({ op: 'result', matchId, winner });
      if (r.error || r.ranked === false || r.state === 'disputed') return null;
      if (r.state === 'final' && r.rating !== undefined && r.delta !== undefined) {
        void this.hello(this.name);
        return { rating: r.rating, delta: r.delta };
      }
    }
    return null;
  }

  async leaderboard(kind: '1' | '2'): Promise<LeaderRow[] | null> {
    if (!this.profile && !(await this.hello(this.name))) return null;
    const r = await this.call<{ rows: LeaderRow[] }>({ op: 'leaderboard', kind });
    return r.rows ?? null;
  }
}
