/**
 * The EVM side: JSON-RPC to the same-origin `/rpc` gateway (only the methods the public gateway allows; no eth_getLogs, so events are read from
 * receipts), the vault's ABI, and EIP-155 legacy transactions signed in the page (ported from nbp tests/live/lib.ts signLegacyTx).
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { rlpEncodeBytes, rlpEncodeList } from '@unicitylabs/native-bridge-plugin';

import { hex, sleep, unhex, waitFor } from './hex.js';
import { evmAddressOf } from './keys.js';

const ALLOWED = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBalance', 'eth_getTransactionCount', 'eth_gasPrice', 'eth_estimateGas',
  'eth_call', 'eth_getCode', 'eth_getTransactionReceipt', 'eth_sendRawTransaction',
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

export interface Receipt {
  status: string;
  transactionHash: string;
  blockHash: string;
  blockNumber: string;
  gasUsed: string;
  logs: { address: string; topics: string[]; data: string }[];
}

export interface TxRequest {
  to: string;
  data?: Uint8Array;
  value?: bigint;
  /** a fixed gas limit; default: eth_estimateGas × 1.2 + 20k */
  gas?: bigint;
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

  receipt = (hash: string): Promise<Receipt | null> => this.rpc<Receipt | null>('eth_getTransactionReceipt', [hash]);
  waitReceipt = (hash: string, timeoutMs = 180_000): Promise<Receipt> =>
    waitFor(`the receipt of ${hash}`, timeoutMs, async () => (await this.receipt(hash)) ?? undefined, 1500);

  /** Sign one legacy transaction (estimate gas, price, check the balance, take the pending nonce); nothing is sent. */
  async sign(secret: Uint8Array, t: TxRequest): Promise<SignedTx> {
    const from = evmAddressOf(secret);
    const value = t.value ?? 0n;
    const data = t.data ?? new Uint8Array();
    const req = { from, to: t.to, data: `0x${hex(data)}`, value: `0x${value.toString(16)}` };
    const gas = t.gas ?? (BigInt(await this.rpc<string>('eth_estimateGas', [req, 'latest'])) * 6n) / 5n + 20_000n;
    const gasPrice = BigInt(await this.rpc<string>('eth_gasPrice')) * 2n;
    const balance = await this.balance(from);
    if (balance < gas * gasPrice + value) throw new Error(`${from} holds ${balance} wei; this needs ${gas * gasPrice + value}: get UCT from the faucet`);
    const nonce = BigInt(await this.rpc<string>('eth_getTransactionCount', [from, 'pending']));
    const { raw, hash } = signLegacyTx({ nonce, gasPrice, gas, to: t.to, value, data, chainId: this.chainId }, secret);
    return { hash, raw, gas, gasPrice, nonce };
  }

  /** eth_sendRawTransaction of signed bytes. Sending the same bytes again is harmless: `alreadyKnown` errors are not errors. */
  async broadcast(raw: string): Promise<void> {
    try {
      await this.rpc('eth_sendRawTransaction', [raw]);
    } catch (e) {
      if (!(e instanceof RpcError && alreadyKnown(e.message))) throw e;
    }
  }

  /** Sign and send one legacy transaction; returns its hash (the receipt is the caller's to wait for). */
  async send(secret: Uint8Array, t: TxRequest): Promise<SignedTx> {
    const signed = await this.sign(secret, t);
    await this.broadcast(signed.raw);
    return signed;
  }
}

export interface SignedTx { hash: string; raw: string; gas: bigint; gasPrice: bigint; nonce: bigint }

/** The node already holds these exact bytes (geth/reth wording). */
export const alreadyKnown = (message: string): boolean => /already known|known transaction|already imported|already exists/i.test(message);

// ---- EIP-155 legacy transaction -----------------------------------------------------------------------------------------------------------------
/** RLP of an unsigned integer: minimal big-endian bytes, zero as the empty string. */
export function rlpUint(n: bigint): Uint8Array {
  if (n < 0n) throw new Error('negative');
  if (n === 0n) return rlpEncodeBytes(new Uint8Array());
  const h = n.toString(16);
  return rlpEncodeBytes(unhex(h.length % 2 ? `0${h}` : h));
}

export interface LegacyTx { nonce: bigint; gasPrice: bigint; gas: bigint; to: string; value: bigint; data: Uint8Array; chainId: bigint }

export function signLegacyTx(t: LegacyTx, secret: Uint8Array): { raw: string; hash: string; signingHash: string } {
  const fields = [rlpUint(t.nonce), rlpUint(t.gasPrice), rlpUint(t.gas), rlpEncodeBytes(unhex(t.to)), rlpUint(t.value), rlpEncodeBytes(t.data)];
  const digest = keccak_256(rlpEncodeList([...fields, rlpUint(t.chainId), rlpUint(0n), rlpUint(0n)]));
  // noble 2: 65 bytes [recovery, r, s], low-s
  const sig = secp256k1.sign(digest, secret, { prehash: false, format: 'recovered' });
  const int = (b: Uint8Array): bigint => BigInt(`0x${hex(b)}`);
  const raw = rlpEncodeList([...fields, rlpUint(t.chainId * 2n + 35n + BigInt(sig[0])), rlpUint(int(sig.subarray(1, 33))), rlpUint(int(sig.subarray(33, 65)))]);
  return { raw: `0x${hex(raw)}`, hash: `0x${hex(keccak_256(raw))}`, signingHash: `0x${hex(digest)}` };
}

// ---- ABI (only what the wallet calls) ------------------------------------------------------------------------------------------------------------
const word = (n: bigint): string => n.toString(16).padStart(64, '0');
export const selector = (signature: string): string => hex(keccak_256(new TextEncoder().encode(signature)).subarray(0, 4));
export const encUint = (n: bigint): string => word(n);
export const encAddress = (a: string): string => {
  if (!isAddress(a)) throw new Error(`not an address: ${a}`);
  return a.slice(2).toLowerCase().padStart(64, '0');
};
/** abi.encode of one `bytes` argument */
export const encBytes = (b: Uint8Array): string => word(32n) + word(BigInt(b.length)) + hex(b) + '00'.repeat((32 - (b.length % 32)) % 32);
export const calldata = (signature: string, ...words: string[]): Uint8Array => unhex(selector(signature) + words.join(''));
export const isAddress = (s: unknown): s is string => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);

/** The returned `bytes` of a call whose only output is `bytes`. */
export function decBytes(ret: string): Uint8Array {
  const b = unhex(ret);
  const offset = Number(BigInt(`0x${hex(b.subarray(0, 32))}`));
  const len = Number(BigInt(`0x${hex(b.subarray(offset, offset + 32))}`));
  if (offset + 32 + len > b.length) throw new Error('the returned bytes are truncated');
  return b.subarray(offset + 32, offset + 32 + len);
}

export const LOCKED_TOPIC = `0x${hex(keccak_256(new TextEncoder().encode('Locked(uint256,address,bytes32,address,bytes32,bytes32,uint256,bytes32,bytes32,bytes32,bytes)')))}`;

/** BridgeVault's custom errors the UI names (nbp tester/core.ts). */
export const VAULT_ERRORS: Record<string, string> = { '0xe8f8709e': 'PartAlreadyRedeemed', '0x2896c49d': 'BridgeRejected' };
export const revertName = (data?: string): string | undefined => (data ? VAULT_ERRORS[data.slice(0, 10).toLowerCase()] ?? data.slice(0, 10) : undefined);
