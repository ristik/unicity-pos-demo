/**
 * Two tabs of one browser hand a token over a BroadcastChannel (no server, no relay). The receiver announces its public key; the sender
 * transfers the token to that key on the aggregator and posts the token file; the receiver verifies it offline and checks it is the owner.
 */
import type { NativeBridge, VerifiedToken } from '@unicitylabs/native-bridge-plugin';
import { Token } from '@unicitylabs/state-transition-sdk/lib/transaction/Token.js';

import { isAddress } from './evm.js';
import { eqBytes, hex, unhex } from './hex.js';
import { predicateOf } from './keys.js';

export type Message =
  | { type: 'hello'; from: string; publicKey: string; evmAddress: string }
  | { type: 'who'; from: string }
  | { type: 'token'; from: string; to: string; bytes: string; amountWei: string };

/** Largest token file accepted over the channel (hex characters): a token is a few KB; this only bounds what a stray tab can make us store. */
export const MAX_TOKEN_HEX = 2_000_000;

const isProfile = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9]{1,8}$/i.test(v);
const isHex = (v: unknown, chars?: number): v is string =>
  typeof v === 'string' && v.length % 2 === 0 && /^[0-9a-f]*$/i.test(v) && (chars === undefined ? v.length > 0 && v.length <= MAX_TOKEN_HEX : v.length === chars);

/** A channel message with every field of the right type, or null: anything another tab posts is untrusted input. */
export function parseMessage(d: unknown): Message | null {
  if (typeof d !== 'object' || d === null) return null;
  const m = d as Record<string, unknown>;
  if (!isProfile(m.from)) return null;
  switch (m.type) {
    case 'who':
      return { type: 'who', from: m.from };
    case 'hello':
      return isHex(m.publicKey, 66) && isAddress(m.evmAddress) ? { type: 'hello', from: m.from, publicKey: m.publicKey, evmAddress: m.evmAddress } : null;
    case 'token':
      return isProfile(m.to) && isHex(m.bytes) && typeof m.amountWei === 'string' && /^\d{1,40}$/.test(m.amountWei)
        ? { type: 'token', from: m.from, to: m.to, bytes: m.bytes, amountWei: m.amountWei } : null;
    default:
      return null;
  }
}

export interface Peer { profile: string; publicKey: string; evmAddress: string }

export class Handoff {
  private readonly ch: BroadcastChannel | null;
  readonly peers = new Map<string, Peer>();

  constructor(readonly profile: string, private readonly me: { publicKey: Uint8Array; evmAddress: string }, private readonly on: {
    peer?: (p: Peer) => void;
    token?: (m: Extract<Message, { type: 'token' }>) => void;
  }) {
    this.ch = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('unicity-demo-handoff');
    if (this.ch) {
      this.ch.onmessage = (e: MessageEvent<unknown>) => {
        const m = parseMessage(e.data);
        if (m) this.receive(m);
        else console.warn('handoff: ignored a malformed message', e.data);
      };
    }
    this.post({ type: 'who', from: profile });
    this.hello();
  }

  private post(m: Message): void {
    this.ch?.postMessage(m);
  }
  hello(): void {
    this.post({ type: 'hello', from: this.profile, publicKey: hex(this.me.publicKey), evmAddress: this.me.evmAddress });
  }

  private receive(m: Message): void {
    if (m.from === this.profile) return;
    if (m.type === 'who') this.hello();
    else if (m.type === 'hello') {
      const p = { profile: m.from, publicKey: m.publicKey, evmAddress: m.evmAddress };
      this.peers.set(m.from, p);
      this.on.peer?.(p);
    } else if (m.type === 'token' && m.to === this.profile) this.on.token?.(m);
  }

  sendToken(to: string, bytes: Uint8Array, amountWei: bigint): void {
    this.post({ type: 'token', from: this.profile, to, bytes: hex(bytes), amountWei: amountWei.toString() });
  }
}

/** The receiver's check: the plug-in verifies the whole token offline ('receipt': held, not burned), and its current owner is this key. */
export async function acceptToken(bridge: NativeBridge, bytesHex: string, myPublicKey: Uint8Array): Promise<{ bytes: Uint8Array; verified: VerifiedToken }> {
  const bytes = unhex(bytesHex);
  const verified = await bridge.verifyNativeTokenBytes(bytes, 'receipt');
  const token = await Token.fromCBOR(bytes);
  const owner = (token.transactions.at(-1) ?? token.genesis).recipient.toCBOR();
  if (!eqBytes(owner, predicateOf(myPublicKey))) throw new Error('the token verifies, but its owner is another key: not addressed to this wallet');
  return { bytes, verified };
}
