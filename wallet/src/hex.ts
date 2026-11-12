/** Byte helpers with no Node dependency (the reference tester uses Buffer; the browser has none). */
export const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function unhex(s: string): Uint8Array {
  const h = s.replace(/^0x/i, '');
  if (h.length % 2 !== 0 || /[^0-9a-f]/i.test(h)) throw new Error(`not hex: ${s.slice(0, 20)}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export const eqBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const short = (h: string, n = 8): string => (h.length > 2 * n + 4 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h);

/** Poll `f` until it returns a value, or throw after `timeoutMs`. */
export async function waitFor<T>(what: string, timeoutMs: number, f: () => Promise<T | undefined>, everyMs = 2000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** wei as a decimal UCT string (18 decimals), trailing zeros trimmed. */
export function fmtUnits(wei: bigint, decimals = 18): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const s = v.toString().padStart(decimals + 1, '0');
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${s.slice(0, -decimals)}${frac ? `.${frac}` : ''}`;
}

/** "0.5" (UCT) to wei; at most 18 decimals. */
export function parseUnits(s: string, decimals = 18): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m || (m[2] ?? '').length > decimals) throw new Error(`not an amount: ${s}`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0'));
}
