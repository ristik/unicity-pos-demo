/**
 * A small JSON-RPC client for the same-origin `/rpc` gateway, for the PoS visualizer's reads (the bridge's own reads go through the plug-in's
 * HttpJsonRpc, which also retries the gateway's 429 and busy 503). Only the public gateway's methods are allowed.
 */
import { hex, sleep } from './hex.js';

const ALLOWED = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getBalance', 'eth_getTransactionCount', 'eth_gasPrice',
  'eth_estimateGas', 'eth_call', 'eth_getCode', 'eth_getTransactionReceipt', 'eth_sendRawTransaction', 'eth_getLogs', 'eth_getBlockReceipts',
  'unicity_getSealCompanionV1', 'unicity_sealCompanionHorizonV1',
]);

/** An HTTP refusal (not a JSON-RPC error inside a 200). */
export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'HttpError';
  }
}

/** A JSON-RPC error; `data` is the revert data of a failed eth_call. */
export class RpcError extends Error {
  constructor(message: string, readonly data?: string) {
    super(message);
    this.name = 'RpcError';
  }
}

export class Evm {
  constructor(readonly url: string, readonly chainId: bigint) {}

  async rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    if (!ALLOWED.has(method)) throw new Error(`${method} is not on the public gateway's allow-list`);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    // the gateway rate-limits per address (429) and answers "busy" (503) when its large-body slots are taken: neither reached upstream, so retry
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      const text = await res.text();
      if ((res.status === 429 || (res.status === 503 && text.includes('busy'))) && attempt < 5) {
        await sleep(1100 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new HttpError(`${method}: HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
      const r = JSON.parse(text) as { result?: T; error?: { message: string; data?: string } };
      if (r.error) throw new RpcError(`${method}: ${r.error.message}`, r.error.data);
      return r.result as T;
    }
  }

  balance = async (a: string): Promise<bigint> => BigInt(await this.rpc<string>('eth_getBalance', [a, 'latest']));
  blockNumber = async (): Promise<bigint> => BigInt(await this.rpc<string>('eth_blockNumber'));
  call = (to: string, data: Uint8Array, from?: string): Promise<string> =>
    this.rpc<string>('eth_call', [{ to, data: `0x${hex(data)}`, ...(from ? { from } : {}) }, 'latest']);
}

export const isAddress = (s: unknown): s is string => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
