import type { Link, NetMsg } from './protocol';

/**
 * A pair of links wired to each other in memory, for tests. Messages are copied through JSON
 * like on a real connection; `fast` messages can be dropped to imitate an unreliable channel.
 */
export function createLoopback(opts: { dropFast?: number; random?: () => number } = {}): [Link, Link] {
  const queues: [NetMsg[], NetMsg[]] = [[], []];
  let open = true;
  const make = (i: 0 | 1): Link & { pump(): void } => ({
    send(msg, fast) {
      if (!open) return;
      if (fast && opts.dropFast && (opts.random ?? Math.random)() < opts.dropFast) return;
      queues[i === 0 ? 1 : 0].push(JSON.parse(JSON.stringify(msg)) as NetMsg);
    },
    onMessage: () => {},
    onClose: () => {},
    close() {
      open = false;
    },
    get open() {
      return open;
    },
    /** Delivers what the other side sent. */
    pump() {
      const q = queues[i];
      while (q.length) this.onMessage(q.shift()!);
    },
  });
  return [make(0), make(1)];
}
