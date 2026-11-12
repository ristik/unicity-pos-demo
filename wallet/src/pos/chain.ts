/**
 * A polite eth_call client for the public gateway: one request at a time, at least `spacingMs` apart (the public route allows about 5
 * requests per second per IP with a small burst; the wallet tab may share that budget), exponential backoff on refusals (the Evm client
 * retries 429/503 itself), and a cache for views that cannot change. Every call is recorded with its decoded result, so each panel's
 * "explain" drawer can show the exact contract calls behind it.
 */
import { Evm } from '../evm.js';
import { sleep } from '../hex.js';
import { decode, encodeArgs, parseSignature, selectorOf, type Arg, type Value } from './abi.js';
import { FN, type FnName, type Role } from './contracts.js';

export interface CallRecord {
  role: Role;
  address: string;
  sig: string;
  args: Arg[];
  value?: Value;
  error?: string;
  cached: boolean;
  ms: number;
  at: number;
}

export type Addresses = Record<Role, string>;

export class Chain {
  readonly evm: Evm;
  private last = 0;
  private cache = new Map<string, Value>();
  /** requests sent (not cached) since the page opened, for the footer */
  sent = 0;
  backoffMs = 0;

  constructor(url: string, readonly addresses: Addresses, readonly spacingMs = 250) {
    this.evm = new Evm(url, 0n);
  }

  /** One raw JSON-RPC request through the queue (spacing and backoff). */
  async raw<T>(method: string, params: unknown[] = []): Promise<T> {
    const wait = this.last + this.spacingMs + this.backoffMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.last = Date.now();
    this.sent++;
    try {
      const r = await this.evm.rpc<T>(method, params);
      this.backoffMs = 0;
      return r;
    } catch (e) {
      // the gateway refused (HTTP) or the network failed: slow down the whole queue, up to 30 s
      if (!(e instanceof Error && e.name === 'RpcError')) this.backoffMs = Math.min(30_000, Math.max(1000, this.backoffMs * 2));
      throw e;
    }
  }

  /** Call one view; `log` receives the record (for the explain drawer). */
  async call<T extends Value = Value>(name: FnName, args: Arg[] = [], log?: CallRecord[]): Promise<T> {
    const fn = FN[name];
    const address = this.addresses[fn.contract];
    if (!address) throw new Error(`no address for ${fn.contract}`);
    const { inputs, canonical } = parseSignature(fn.sig);
    const data = `0x${selectorOf(canonical)}${encodeArgs(inputs, args)}`;
    const key = `${address.toLowerCase()}:${data}`;
    const rec: CallRecord = { role: fn.contract, address, sig: fn.sig, args, cached: false, ms: 0, at: Date.now() };
    log?.push(rec);
    if (fn.immutable && this.cache.has(key)) {
      rec.cached = true;
      rec.value = this.cache.get(key);
      return rec.value as T;
    }
    const t0 = performance.now();
    try {
      const ret = await this.raw<string>('eth_call', [{ to: address, data }, 'latest']);
      const v = decode(fn.out, ret);
      rec.value = v;
      if (fn.immutable) this.cache.set(key, v);
      return v as T;
    } catch (e) {
      rec.error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      rec.ms = performance.now() - t0;
    }
  }
}

// ---- small value helpers ------------------------------------------------------------------------------------------------------------------------
export const big = (v: Value | undefined): bigint => (typeof v === 'bigint' ? v : 0n);
export const str = (v: Value | undefined): string => (typeof v === 'string' ? v : '');
export const obj = (v: Value | undefined): Record<string, Value> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Value>) : {});
export const arr = (v: Value | undefined): Value[] => (Array.isArray(v) ? v : []);
export const ZERO32 = `0x${'0'.repeat(64)}`;
export const isZero = (h: string): boolean => /^0x0*$/.test(h);

/** A decoded value as compact JSON-ish text (bigints as decimals), for the explain drawer. */
export function show(v: Value | undefined, depth = 0): string {
  if (v === undefined) return '—';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return v;
  const pad = '  '.repeat(depth + 1);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (v.every((x) => typeof x !== 'object')) return `[${v.map((x) => show(x)).join(', ')}]`;
    return `[\n${v.map((x) => pad + show(x, depth + 1)).join(',\n')}\n${'  '.repeat(depth)}]`;
  }
  const ks = Object.keys(v);
  if (ks.every((k) => typeof v[k] !== 'object')) {
    const flat = `{ ${ks.map((k) => `${k}: ${show(v[k])}`).join(', ')} }`;
    if (flat.length < 90) return flat;
  }
  return `{\n${ks.map((k) => `${pad}${k}: ${show(v[k], depth + 1)}`).join(',\n')}\n${'  '.repeat(depth)}}`;
}
