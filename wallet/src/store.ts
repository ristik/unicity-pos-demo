/**
 * localStorage, namespaced per wallet profile (`?w=b` opens a second, independent wallet in another tab: two tabs of one origin share storage).
 * Every access is guarded: storage can be absent or throw (private windows, blocked site data). Without it the wallet still runs, but forgets.
 */
const profile = (): string => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('w') ?? 'a';
  } catch {
    return 'a';
  }
};
export const PROFILE = profile().replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'a';
const key = (k: string): string => `unicity-demo.${PROFILE}.${k}`;

let warned = false;
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function load(k: string): string | null {
  try {
    return storage()?.getItem(key(k)) ?? null;
  } catch {
    return null;
  }
}

export function save(k: string, v: string): boolean {
  try {
    const s = storage();
    if (!s) throw new Error('no storage');
    s.setItem(key(k), v);
    return true;
  } catch (e) {
    if (!warned) console.warn(`storage unavailable, ${k} is kept in memory only`, e);
    warned = true;
    return false;
  }
}

export function remove(k: string): void {
  try {
    storage()?.removeItem(key(k));
  } catch {
    /* nothing to do */
  }
}

export const loadJson = <T>(k: string, fallback: T): T => {
  const v = load(k);
  if (v === null) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
export const saveJson = (k: string, v: unknown): boolean => save(k, JSON.stringify(v));
