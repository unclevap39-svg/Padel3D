import { getStore } from '@netlify/blobs';
import type { Config } from '@netlify/functions';
import { type KV, handle } from '../../server/online';

/** Online lobby endpoint: matchmaking, invitations, signalling, ranked results, leaderboard. */
export default async (req: Request) => {
  if (req.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > 40000) return Response.json({ error: 'too_large' }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: 'bad_json' }, { status: 400 });
  }
  // Strong consistency: a player must see a claim on its queue ticket as soon as it is written.
  const store = getStore({ name: 'padel3d-online', consistency: 'strong' });
  const kv: KV = {
    get: (key) => store.get(key, { type: 'json' }),
    set: async (key, value, opts) => {
      const res = await store.setJSON(key, value, opts?.onlyIfNew ? { onlyIfNew: true } : undefined);
      return res.modified;
    },
    delete: (key) => store.delete(key),
    list: async (prefix) => (await store.list({ prefix })).blobs.map((b) => b.key),
  };
  const reply = await handle(kv, body, Date.now());
  return Response.json(reply.body, { status: reply.status, headers: { 'cache-control': 'no-store' } });
};

export const config: Config = { path: '/api/online' };
