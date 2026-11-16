/** Reuse confirmed JSON branches so a progressive update only changes affected views. */
export function retainConfirmedValue<T>(previous: T | undefined, incoming: T): T {
  if (Object.is(previous, incoming)) return previous as T;
  if (!previous || !incoming || typeof previous !== 'object' || typeof incoming !== 'object' || Array.isArray(previous) !== Array.isArray(incoming)) return incoming;
  const before = previous as Record<string, unknown>, next = incoming as Record<string, unknown>;
  const keys = Object.keys(next);
  let unchanged = Object.keys(before).length === keys.length;
  const result = (Array.isArray(incoming) ? [] : {}) as Record<string, unknown>;
  for (const key of keys) {
    const value = retainConfirmedValue(before[key], next[key]);
    Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
    if (!Object.prototype.hasOwnProperty.call(before, key) || value !== before[key]) unchanged = false;
  }
  return unchanged ? previous : result as T;
}

export type DashboardSnapshotBaseline = { revision: number; state: Record<string, unknown> };

/** Field updates share one ordered socket; reconnects start with a complete snapshot. */
export function nextDashboardSnapshot(previous: DashboardSnapshotBaseline | undefined, state: object) {
  const normalized = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  const revision = (previous?.revision ?? 0) + 1;
  const baseline = { revision, state: normalized };
  if (!previous) return { baseline, message: { type: 'dashboard:snapshot', revision, state: normalized } };
  const changes = Object.fromEntries(Object.entries(normalized).filter(([key, value]) => JSON.stringify(previous.state[key]) !== JSON.stringify(value)));
  const removed = Object.keys(previous.state).filter(key => !(key in normalized));
  if (!Object.keys(changes).length && !removed.length) return undefined;
  return { baseline, message: { type: 'dashboard:update', baseRevision: previous.revision, revision, changes, removed } };
}
