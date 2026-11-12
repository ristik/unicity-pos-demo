/**
 * Two tabs of one browser hand a token over a BroadcastChannel (no server, no relay). The receiver announces its public key; the sender
 * transfers the token to that key on the aggregator and posts the token file; the receiver verifies it offline and checks it is the owner.
 */
import type { NativeBridge, VerifiedToken } from '@unicitylabs/native-bridge-plugin';
import { Token } from '@unicitylabs/state-transition-sdk/lib/transaction/Token.js';

import { eqBytes, hex, unhex } from './hex.js';
import { predicateOf } from './keys.js';

export type Message =
  | { type: 'hello'; from: string; publicKey: string; evmAddress: string }
  | { type: 'who'; from: string }
  | { type: 'token'; from: string; to: string; bytes: string; amountWei: string };

export interface Peer { profile: string; publicKey: string; evmAddress: string }

export class Handoff {
  private readonly ch: BroadcastChannel | null;
  readonly peers = new Map<string, Peer>();

  constructor(readonly profile: string, private readonly me: { publicKey: Uint8Array; evmAddress: string }, private readonly on: {
    peer?: (p: Peer) => void;
    token?: (m: Extract<Message, { type: 'token' }>) => void;
  }) {
    this.ch = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('unicity-demo-handoff');
    if (this.ch) this.ch.onmessage = (e: MessageEvent<Message>) => this.receive(e.data);
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
