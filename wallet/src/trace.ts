/**
 * What each step sent and received, for the "explain" drawer: every fetch the page makes (our JSON-RPC, the SDK's aggregator calls, the
 * trust-base pages, the lock-proof endpoint) is recorded against the step that is running, with sizes and timings, plus the step's own facts
 * (tx hashes, proof sizes, ...). One step runs at a time, so a single "current" trace is enough.
 */
export interface Call {
  method: string;
  url: string;
  status: number;
  reqBytes: number;
  resBytes: number;
  ms: number;
  contentType: string;
  /** the request's JSON-RPC params, trimmed */
  params?: string;
  /** the response, trimmed (JSON) or summarised (CBOR) */
  result?: string;
}

export interface Trace {
  calls: Call[];
  facts: [string, string][];
  startedAt: number;
  ms?: number;
}

let current: Trace | null = null;

export function begin(): Trace {
  current = { calls: [], facts: [], startedAt: performance.now() };
  return current;
}
export function end(t: Trace): void {
  t.ms = performance.now() - t.startedAt;
  if (current === t) current = null;
}
/** A fact about the running step (shown in its drawer). */
export function fact(k: string, v: string | number | bigint): void {
  current?.facts.push([k, String(v)]);
}

const trim = (s: string, n = 240): string => (s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s);

function bodyLength(b: BodyInit | null | undefined): number {
  if (b == null) return 0;
  if (typeof b === 'string') return new TextEncoder().encode(b).length;
  if (b instanceof Uint8Array || b instanceof ArrayBuffer) return b.byteLength;
  return 0;
}

let installed = false;
export function installFetchTrace(): void {
  if (installed) return;
  installed = true;
  const orig = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const t = current;
    if (!t) return orig(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let method = init?.method ?? 'GET';
    let params: string | undefined;
    if (typeof init?.body === 'string' && init.body.startsWith('{')) {
      try {
        const j = JSON.parse(init.body) as { method?: string; params?: unknown };
        if (j.method) method = j.method;
        params = trim(JSON.stringify(j.params));
      } catch {
        /* not JSON-RPC */
      }
    }
    const t0 = performance.now();
    const call: Call = { method, url: url.replace(/^https?:\/\/[^/]+/, ''), status: 0, reqBytes: bodyLength(init?.body), resBytes: 0, ms: 0, contentType: '', params };
    t.calls.push(call);
    try {
      const res = await orig(input, init);
      call.status = res.status;
      call.contentType = res.headers.get('content-type') ?? '';
      const buf = new Uint8Array(await res.clone().arrayBuffer());
      call.resBytes = buf.length;
      call.ms = performance.now() - t0;
      if (call.contentType.includes('json')) call.result = trim(new TextDecoder().decode(buf));
      else if (buf.length) call.result = `${call.contentType || 'bytes'}: ${buf.length} bytes`;
      return res;
    } catch (e) {
      call.ms = performance.now() - t0;
      call.result = `network error: ${String(e)}`;
      throw e;
    }
  };
}
