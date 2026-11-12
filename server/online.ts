/**
 * Online lobby: player identities, matchmaking queues, invitation rooms, connection signalling,
 * ranked results and leaderboards. Pure logic over a small key-value interface, so the same
 * code runs in the Netlify function (on Netlify Blobs), in the dev server and in unit tests.
 *
 * Nothing here is read-modify-write on a shared key: every contested step is a create-if-absent
 * write (`onlyIfNew`), which the store makes atomic. Player records are only rewritten after
 * the single ranked-result lock of a match has been taken.
 */

export interface KV {
  get<T>(key: string): Promise<T | null>;
  /** Returns false when `onlyIfNew` was requested and the key already existed. */
  set(key: string, value: unknown, opts?: { onlyIfNew?: boolean }): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export type QueueMode = 'c1' | 'r1' | 'c2' | 'r2';
const MODES: QueueMode[] = ['c1', 'r1', 'c2', 'r2'];

interface PlayerRecord {
  name: string;
  hash: string;
  /** Ratings and results for 1v1 and 2v2. */
  r1: number;
  r2: number;
  w1: number;
  l1: number;
  w2: number;
  l2: number;
}

interface QueueEntry {
  id: string;
  name: string;
  elo: number;
  seen: number;
}

interface MatchRecord {
  mode: string; // queue mode, or 'i1' / 'i2' for invitations
  host: string;
  guest: string;
  hostName: string;
  guestName: string;
  hostElo: number;
  guestElo: number;
  ts: number;
}

interface Claim {
  self?: boolean;
  id?: string;
  matchId?: string;
  host?: string;
  hostName?: string;
  hostElo?: number;
  guestName?: string;
  guestElo?: number;
  ts: number;
}

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

const ok = (body: Record<string, unknown>): Reply => ({ status: 200, body });
const fail = (status: number, error: string): Reply => ({ status, body: { error } });

const START_RATING = 1000;
const QUEUE_STALE_MS = 8000;
const ROOM_TTL_MS = 15 * 60 * 1000;
const ID_RE = /^[a-z0-9-]{8,40}$/;
const TICKET_RE = /^[a-z0-9]{6,12}-[a-z0-9-]{8,40}$/;
const CODE_RE = /^[A-Z2-9]{5}$/;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function cleanName(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f<>&"'`]/g, '')
    .trim()
    .slice(0, 14);
  return s || 'Joueur';
}

const kindOf = (mode: string): '1' | '2' => (mode.endsWith('1') ? '1' : '2');
const isRanked = (mode: string): boolean => mode[0] === 'r';
const rating = (p: PlayerRecord, kind: '1' | '2'): number => (kind === '1' ? p.r1 : p.r2);

function publicProfile(p: PlayerRecord) {
  return { name: p.name, r1: p.r1, r2: p.r2, w1: p.w1, l1: p.l1, w2: p.w2, l2: p.l2 };
}

/** Handles one request. `now` is passed in so tests control the clock. */
export async function handle(kv: KV, body: unknown, now: number): Promise<Reply> {
  if (!body || typeof body !== 'object') return fail(400, 'bad_request');
  const b = body as Record<string, unknown>;
  const op = String(b.op ?? '');
  const id = String(b.id ?? '');
  const secret = String(b.secret ?? '');
  if (!ID_RE.test(id) || secret.length < 16 || secret.length > 80) return fail(400, 'bad_identity');
  const hash = await sha256(secret);
  const playerKey = `player/${id}`;

  // --- Identity ------------------------------------------------------------------------------
  let me = await kv.get<PlayerRecord>(playerKey);
  if (op === 'hello') {
    if (!me) {
      me = { name: cleanName(b.name), hash, r1: START_RATING, r2: START_RATING, w1: 0, l1: 0, w2: 0, l2: 0 };
      const created = await kv.set(playerKey, me, { onlyIfNew: true });
      if (!created) me = await kv.get<PlayerRecord>(playerKey);
    }
    if (!me || me.hash !== hash) return fail(401, 'wrong_secret');
    const name = cleanName(b.name);
    if (b.name !== undefined && name !== me.name) {
      me = { ...me, name };
      await kv.set(playerKey, me);
    }
    return ok({ profile: publicProfile(me) });
  }
  if (!me || me.hash !== hash) return fail(401, 'unknown_player');

  const matchedReply = (matchId: string, role: 'host' | 'guest', mode: string, oppName: string, oppElo: number): Reply =>
    ok({ state: 'matched', matchId, role, mode, opponent: { name: oppName, elo: oppElo } });

  switch (op) {
    // --- Matchmaking queue -------------------------------------------------------------------
    case 'queue': {
      const mode = String(b.mode ?? '') as QueueMode;
      if (!MODES.includes(mode)) return fail(400, 'bad_mode');
      const kind = kindOf(mode);
      let ticket = String(b.ticket ?? '');
      if (!TICKET_RE.test(ticket) || !ticket.endsWith(`-${id}`)) ticket = `${now.toString(36).padStart(9, '0')}-${id}`;
      const myKey = `q/${mode}/${ticket}`;
      const myClaimKey = `claim/${ticket}`;

      const claimed = async (): Promise<Reply | null> => {
        const c = await kv.get<Claim>(myClaimKey);
        if (!c || !c.matchId) return null;
        await kv.delete(myKey);
        if (c.self) return matchedReply(c.matchId, 'host', mode, c.guestName ?? 'Joueur', c.guestElo ?? START_RATING);
        return matchedReply(c.matchId, 'guest', mode, c.hostName ?? 'Joueur', c.hostElo ?? START_RATING);
      };
      const already = await claimed();
      if (already) return already;

      const myElo = rating(me, kind);
      await kv.set(myKey, { id, name: me.name, elo: myElo, seen: now } satisfies QueueEntry);

      // Only ever claim players who were waiting before us: two players can never claim each other.
      const keys = (await kv.list(`q/${mode}/`)).filter((k) => k < myKey).sort();
      let best: { key: string; entry: QueueEntry } | null = null;
      for (const key of keys.slice(0, 12)) {
        const entry = await kv.get<QueueEntry>(key);
        if (!entry || entry.id === id) continue;
        if (now - entry.seen > QUEUE_STALE_MS) {
          await kv.delete(key); // left without cancelling
          continue;
        }
        if (!best || (isRanked(mode) && Math.abs(entry.elo - myElo) < Math.abs(best.entry.elo - myElo))) best = { key, entry };
        if (!isRanked(mode)) break; // classic: first come, first served
      }
      if (!best) return ok({ state: 'waiting', ticket });

      // Lock ourselves first so nobody claims us while we claim them.
      if (!(await kv.set(myClaimKey, { self: true, id, ts: now } satisfies Claim, { onlyIfNew: true }))) {
        return (await claimed()) ?? ok({ state: 'waiting', ticket });
      }
      const theirTicket = best.key.slice(`q/${mode}/`.length);
      const matchId = `m${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
      const won = await kv.set(
        `claim/${theirTicket}`,
        { matchId, host: id, hostName: me.name, hostElo: myElo, ts: now } satisfies Claim,
        { onlyIfNew: true },
      );
      if (!won) {
        await kv.delete(myClaimKey);
        return ok({ state: 'waiting', ticket });
      }
      const match: MatchRecord = { mode, host: id, guest: best.entry.id, hostName: me.name, guestName: best.entry.name, hostElo: myElo, guestElo: best.entry.elo, ts: now };
      await kv.set(`match/${matchId}`, match);
      await kv.set(myClaimKey, { self: true, id, matchId, guestName: best.entry.name, guestElo: best.entry.elo, ts: now } satisfies Claim);
      await kv.delete(myKey);
      return matchedReply(matchId, 'host', mode, best.entry.name, best.entry.elo);
    }

    case 'cancel': {
      const mode = String(b.mode ?? '');
      const ticket = String(b.ticket ?? '');
      if (!MODES.includes(mode as QueueMode) || !TICKET_RE.test(ticket) || !ticket.endsWith(`-${id}`)) return fail(400, 'bad_ticket');
      await kv.delete(`q/${mode}/${ticket}`);
      const c = await kv.get<Claim>(`claim/${ticket}`);
      if (c?.self && !c.matchId) await kv.delete(`claim/${ticket}`);
      return ok({ state: 'cancelled' });
    }

    // --- Invitation rooms ----------------------------------------------------------------------
    case 'room-create': {
      const kind = b.kind === '1' ? '1' : '2';
      for (let attempt = 0; attempt < 6; attempt++) {
        let code = '';
        for (let i = 0; i < 5; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
        const created = await kv.set(`room/${code}`, { host: id, name: me.name, elo: rating(me, kind), kind, ts: now }, { onlyIfNew: true });
        if (created) return ok({ code, kind });
      }
      return fail(503, 'no_code');
    }

    case 'room-join':
    case 'room-poll': {
      const code = String(b.code ?? '').toUpperCase();
      if (!CODE_RE.test(code)) return fail(400, 'bad_code');
      const room = await kv.get<{ host: string; name: string; elo: number; kind: '1' | '2'; ts: number }>(`room/${code}`);
      if (!room || now - room.ts > ROOM_TTL_MS) return fail(404, 'room_not_found');
      const matchId = `room-${code}-${room.ts.toString(36)}`;
      const mode = `i${room.kind}`;
      if (op === 'room-poll') {
        if (room.host !== id) return fail(403, 'not_host');
        const guest = await kv.get<{ id: string; name: string; elo: number }>(`roomguest/${code}`);
        if (!guest) return ok({ state: 'waiting', code });
        return matchedReply(matchId, 'host', mode, guest.name, guest.elo);
      }
      if (room.host === id) return fail(400, 'own_room');
      const seat = { id, name: me.name, elo: rating(me, room.kind) };
      if (!(await kv.set(`roomguest/${code}`, seat, { onlyIfNew: true }))) {
        const taken = await kv.get<{ id: string }>(`roomguest/${code}`);
        if (taken?.id !== id) return fail(409, 'room_full');
      }
      const match: MatchRecord = { mode, host: room.host, guest: id, hostName: room.name, guestName: me.name, hostElo: room.elo, guestElo: seat.elo, ts: now };
      await kv.set(`match/${matchId}`, match, { onlyIfNew: true });
      return matchedReply(matchId, 'guest', mode, room.name, room.elo);
    }

    // --- Connection signalling: one offer from the host, one answer from the guest ---------------
    case 'signal-put':
    case 'signal-get': {
      const matchId = String(b.matchId ?? '');
      const kind = b.kind === 'answer' ? 'answer' : 'offer';
      const match = /^[A-Za-z0-9-]{4,60}$/.test(matchId) ? await kv.get<MatchRecord>(`match/${matchId}`) : null;
      if (!match || (match.host !== id && match.guest !== id)) return fail(403, 'not_in_match');
      const key = `sig/${matchId}/${kind}`;
      if (op === 'signal-get') return ok({ sdp: (await kv.get<{ sdp: string }>(key))?.sdp ?? null });
      const sender = kind === 'offer' ? match.host : match.guest;
      const sdp = String(b.sdp ?? '');
      if (sender !== id || sdp.length < 20 || sdp.length > 20000) return fail(400, 'bad_signal');
      await kv.set(key, { sdp });
      return ok({ stored: true });
    }

    // --- Ranked results ----------------------------------------------------------------------------
    case 'result': {
      const matchId = String(b.matchId ?? '');
      const match = /^[A-Za-z0-9-]{4,60}$/.test(matchId) ? await kv.get<MatchRecord>(`match/${matchId}`) : null;
      if (!match || (match.host !== id && match.guest !== id)) return fail(403, 'not_in_match');
      if (!isRanked(match.mode)) return ok({ ranked: false });
      const role = match.host === id ? 'host' : 'guest';
      const winner = b.winner === 'guest' ? 'guest' : 'host';
      await kv.set(`res/${matchId}/${role}`, { winner, ts: now }, { onlyIfNew: true });
      const mine = await kv.get<{ winner: string; ts: number }>(`res/${matchId}/${role}`);
      const theirs = await kv.get<{ winner: string }>(`res/${matchId}/${role === 'host' ? 'guest' : 'host'}`);
      const kind = kindOf(match.mode);
      const final = async (): Promise<Reply> => {
        const f = await kv.get<{ winner: string; host: number; guest: number; hostDelta: number; guestDelta: number }>(`res/${matchId}/final`);
        if (!f) return ok({ ranked: true, state: 'pending' });
        return ok({ ranked: true, state: 'final', winner: f.winner, rating: f[role], delta: role === 'host' ? f.hostDelta : f.guestDelta });
      };
      // Both players must agree. A lone report counts only once the other side has had 30 s to
      // send its own (it left the match): the player who stayed is believed.
      const agreed = theirs && mine && theirs.winner === mine.winner;
      const alone = !theirs && mine && now - mine.ts > 30000;
      if (theirs && mine && theirs.winner !== mine.winner) return ok({ ranked: true, state: 'disputed' });
      if (!agreed && !alone) return ok({ ranked: true, state: 'pending' });
      if (!(await kv.set(`res/${matchId}/applied`, { ts: now }, { onlyIfNew: true }))) return final();

      const hostRec = await kv.get<PlayerRecord>(`player/${match.host}`);
      const guestRec = await kv.get<PlayerRecord>(`player/${match.guest}`);
      if (!hostRec || !guestRec) return ok({ ranked: true, state: 'pending' });
      const ra = rating(hostRec, kind);
      const rb = rating(guestRec, kind);
      const expected = 1 / (1 + 10 ** ((rb - ra) / 400));
      const hostWon = mine!.winner === 'host';
      const hostDelta = Math.round(32 * ((hostWon ? 1 : 0) - expected));
      const guestDelta = -hostDelta;
      const apply = (p: PlayerRecord, delta: number, won: boolean): PlayerRecord =>
        kind === '1'
          ? { ...p, r1: p.r1 + delta, w1: p.w1 + (won ? 1 : 0), l1: p.l1 + (won ? 0 : 1) }
          : { ...p, r2: p.r2 + delta, w2: p.w2 + (won ? 1 : 0), l2: p.l2 + (won ? 0 : 1) };
      await kv.set(`player/${match.host}`, apply(hostRec, hostDelta, hostWon));
      await kv.set(`player/${match.guest}`, apply(guestRec, guestDelta, !hostWon));
      await kv.set(`res/${matchId}/final`, { winner: mine!.winner, host: ra + hostDelta, guest: rb + guestDelta, hostDelta, guestDelta });
      return final();
    }

    // --- Leaderboard -------------------------------------------------------------------------------
    case 'leaderboard': {
      const kind = b.kind === '1' ? '1' : '2';
      const cached = await kv.get<{ ts: number; rows: unknown[] }>(`lb/${kind}`);
      if (cached && now - cached.ts < 60000) return ok({ rows: cached.rows, me: publicProfile(me) });
      const keys = (await kv.list('player/')).slice(0, 400);
      const rows: Array<{ name: string; rating: number; wins: number; losses: number }> = [];
      for (const key of keys) {
        const p = await kv.get<PlayerRecord>(key);
        if (!p) continue;
        const wins = kind === '1' ? p.w1 : p.w2;
        const losses = kind === '1' ? p.l1 : p.l2;
        if (wins + losses > 0) rows.push({ name: p.name, rating: rating(p, kind), wins, losses });
      }
      rows.sort((x, y) => y.rating - x.rating);
      const top = rows.slice(0, 20);
      await kv.set(`lb/${kind}`, { ts: now, rows: top });
      return ok({ rows: top, me: publicProfile(me) });
    }
  }
  return fail(400, 'unknown_op');
}

/** In-memory store for the dev server and the unit tests. */
export function memoryKV(): KV {
  const data = new Map<string, string>();
  return {
    async get<T>(key: string) {
      const v = data.get(key);
      return v === undefined ? null : (JSON.parse(v) as T);
    },
    async set(key, value, opts) {
      if (opts?.onlyIfNew && data.has(key)) return false;
      data.set(key, JSON.stringify(value));
      return true;
    },
    async delete(key) {
      data.delete(key);
    },
    async list(prefix) {
      return [...data.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}
