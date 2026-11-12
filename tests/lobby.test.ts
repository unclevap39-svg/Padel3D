import { describe, expect, it } from 'vitest';
import { type KV, handle, memoryKV } from '../server/online';

const who = (n: number) => ({ id: `player-${n}-abcdef`, secret: `secret-${n}-0123456789abcdef` });
async function call(kv: KV, n: number, body: Record<string, unknown>, now: number) {
  return handle(kv, { ...who(n), ...body }, now);
}
async function hello(kv: KV, n: number, now = 1000) {
  return call(kv, n, { op: 'hello', name: `Joueur${n}` }, now);
}

describe('online lobby', () => {
  it('registers a player and refuses a wrong secret', async () => {
    const kv = memoryKV();
    const a = await hello(kv, 1);
    expect(a.body.profile).toMatchObject({ name: 'Joueur1', r1: 1000, r2: 1000 });
    const bad = await handle(kv, { id: who(1).id, secret: 'another-secret-0123456789', op: 'hello' }, 1000);
    expect(bad.status).toBe(401);
    const stranger = await call(kv, 9, { op: 'queue', mode: 'c1' }, 1000);
    expect(stranger.status).toBe(401);
  });

  it('cleans names', async () => {
    const kv = memoryKV();
    const r = await call(kv, 1, { op: 'hello', name: '<b>Très long nom de joueur</b>' }, 1);
    expect((r.body.profile as { name: string }).name).toBe('bTrès long nom');
  });

  it('pairs two players waiting in the same queue, the newcomer hosting', async () => {
    const kv = memoryKV();
    await hello(kv, 1);
    await hello(kv, 2);
    const a1 = await call(kv, 1, { op: 'queue', mode: 'r1' }, 2000);
    expect(a1.body.state).toBe('waiting');
    const b1 = await call(kv, 2, { op: 'queue', mode: 'r1' }, 3000);
    expect(b1.body).toMatchObject({ state: 'matched', role: 'host', mode: 'r1', opponent: { name: 'Joueur1' } });
    const a2 = await call(kv, 1, { op: 'queue', mode: 'r1', ticket: a1.body.ticket }, 3500);
    expect(a2.body).toMatchObject({ state: 'matched', role: 'guest', matchId: b1.body.matchId, opponent: { name: 'Joueur2' } });
    // Asking again gives the same match.
    const b2 = await call(kv, 2, { op: 'queue', mode: 'r1', ticket: b1.body.ticket }, 3600);
    expect(b2.body.state).toBe('waiting'); // its ticket was consumed: a fresh search starts
  });

  it('does not pair players from different queues or a player who stopped polling', async () => {
    const kv = memoryKV();
    await hello(kv, 1);
    await hello(kv, 2);
    await hello(kv, 3);
    await call(kv, 1, { op: 'queue', mode: 'c2' }, 1000);
    expect((await call(kv, 2, { op: 'queue', mode: 'c1' }, 2000)).body.state).toBe('waiting');
    // Player 1 went away 20 s ago: player 3 must not be matched with a ghost.
    expect((await call(kv, 3, { op: 'queue', mode: 'c2' }, 21000)).body.state).toBe('waiting');
  });

  it('never matches three players into the same game', async () => {
    const kv = memoryKV();
    for (const n of [1, 2, 3]) await hello(kv, n);
    const a = await call(kv, 1, { op: 'queue', mode: 'c1' }, 1000);
    const [b, c] = await Promise.all([call(kv, 2, { op: 'queue', mode: 'c1' }, 1500), call(kv, 3, { op: 'queue', mode: 'c1' }, 1600)]);
    const matched = [b, c].filter((r) => r.body.state === 'matched');
    expect(matched).toHaveLength(1);
    const a2 = await call(kv, 1, { op: 'queue', mode: 'c1', ticket: a.body.ticket }, 1700);
    expect(a2.body.matchId).toBe(matched[0].body.matchId);
  });

  it('cancels a search', async () => {
    const kv = memoryKV();
    await hello(kv, 1);
    await hello(kv, 2);
    const a = await call(kv, 1, { op: 'queue', mode: 'c1' }, 1000);
    await call(kv, 1, { op: 'cancel', mode: 'c1', ticket: a.body.ticket }, 1100);
    expect((await call(kv, 2, { op: 'queue', mode: 'c1' }, 1200)).body.state).toBe('waiting');
  });

  it('runs an invitation room with a code, for one guest only', async () => {
    const kv = memoryKV();
    for (const n of [1, 2, 3]) await hello(kv, n);
    const room = await call(kv, 1, { op: 'room-create', kind: '1' }, 1000);
    const code = room.body.code as string;
    expect(code).toMatch(/^[A-Z2-9]{5}$/);
    expect((await call(kv, 1, { op: 'room-poll', code }, 1100)).body.state).toBe('waiting');
    const joined = await call(kv, 2, { op: 'room-join', code: code.toLowerCase() }, 1200);
    expect(joined.body).toMatchObject({ state: 'matched', role: 'guest', mode: 'i1', opponent: { name: 'Joueur1' } });
    expect((await call(kv, 3, { op: 'room-join', code }, 1300)).status).toBe(409);
    const host = await call(kv, 1, { op: 'room-poll', code }, 1400);
    expect(host.body).toMatchObject({ state: 'matched', role: 'host', matchId: joined.body.matchId });
    expect((await call(kv, 2, { op: 'room-join', code: 'ZZZZZ' }, 1500)).status).toBe(404);
  });

  it('relays the connection offer and answer between the two players only', async () => {
    const kv = memoryKV();
    for (const n of [1, 2, 3]) await hello(kv, n);
    await call(kv, 1, { op: 'queue', mode: 'c1' }, 1000);
    const m = await call(kv, 2, { op: 'queue', mode: 'c1' }, 1100);
    const matchId = m.body.matchId;
    const sdp = 'v=0 '.padEnd(60, 'x');
    expect((await call(kv, 1, { op: 'signal-put', matchId, kind: 'offer', sdp }, 1200)).status).toBe(400); // the guest cannot post the offer
    expect((await call(kv, 2, { op: 'signal-put', matchId, kind: 'offer', sdp }, 1200)).body.stored).toBe(true);
    expect((await call(kv, 1, { op: 'signal-get', matchId, kind: 'offer' }, 1300)).body.sdp).toBe(sdp);
    expect((await call(kv, 3, { op: 'signal-get', matchId, kind: 'offer' }, 1300)).status).toBe(403);
    expect((await call(kv, 1, { op: 'signal-get', matchId, kind: 'answer' }, 1300)).body.sdp).toBeNull();
  });

  it('updates ratings once when both players report the same ranked result', async () => {
    const kv = memoryKV();
    await hello(kv, 1);
    await hello(kv, 2);
    await call(kv, 1, { op: 'queue', mode: 'r2' }, 1000);
    const m = await call(kv, 2, { op: 'queue', mode: 'r2' }, 1100); // player 2 hosts
    const matchId = m.body.matchId;
    expect((await call(kv, 2, { op: 'result', matchId, winner: 'host' }, 5000)).body.state).toBe('pending');
    const g = await call(kv, 1, { op: 'result', matchId, winner: 'host' }, 5100);
    expect(g.body).toMatchObject({ state: 'final', winner: 'host', rating: 984, delta: -16 });
    const h = await call(kv, 2, { op: 'result', matchId, winner: 'host' }, 5200);
    expect(h.body).toMatchObject({ state: 'final', rating: 1016, delta: 16 });
    // Reporting again changes nothing.
    await call(kv, 2, { op: 'result', matchId, winner: 'host' }, 5300);
    const me = await hello(kv, 2, 6000);
    expect(me.body.profile).toMatchObject({ r2: 1016, w2: 1, l2: 0, r1: 1000 });
    const board = await call(kv, 1, { op: 'leaderboard', kind: '2' }, 7000);
    expect(board.body.rows).toEqual([
      { name: 'Joueur2', rating: 1016, wins: 1, losses: 0 },
      { name: 'Joueur1', rating: 984, wins: 0, losses: 1 },
    ]);
  });

  it('rejects conflicting reports and believes a lone report only after a delay', async () => {
    const kv = memoryKV();
    for (const n of [1, 2, 3, 4]) await hello(kv, n);
    await call(kv, 1, { op: 'queue', mode: 'r1' }, 1000);
    const m = await call(kv, 2, { op: 'queue', mode: 'r1' }, 1100);
    await call(kv, 2, { op: 'result', matchId: m.body.matchId, winner: 'host' }, 2000);
    expect((await call(kv, 1, { op: 'result', matchId: m.body.matchId, winner: 'guest' }, 2100)).body.state).toBe('disputed');
    expect((await hello(kv, 2, 3000)).body.profile).toMatchObject({ r1: 1000 });

    await call(kv, 3, { op: 'queue', mode: 'r1' }, 10000);
    const m2 = await call(kv, 4, { op: 'queue', mode: 'r1' }, 10100);
    expect((await call(kv, 4, { op: 'result', matchId: m2.body.matchId, winner: 'host' }, 11000)).body.state).toBe('pending');
    expect((await call(kv, 4, { op: 'result', matchId: m2.body.matchId, winner: 'host' }, 20000)).body.state).toBe('pending');
    expect((await call(kv, 4, { op: 'result', matchId: m2.body.matchId, winner: 'host' }, 42000)).body.state).toBe('final');
  });

  it('does not rate invitation or classic matches', async () => {
    const kv = memoryKV();
    await hello(kv, 1);
    await hello(kv, 2);
    await call(kv, 1, { op: 'queue', mode: 'c1' }, 1000);
    const m = await call(kv, 2, { op: 'queue', mode: 'c1' }, 1100);
    expect((await call(kv, 2, { op: 'result', matchId: m.body.matchId, winner: 'host' }, 2000)).body.ranked).toBe(false);
  });
});
