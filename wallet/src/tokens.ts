/**
 * The wallet's token records. They are the wallet's own view (which token file it holds, what a step is waiting for); the bridge's deposits
 * and returns live in the plug-in's journal (idb.ts, the same durable store). Every write is awaited until it is committed (durability
 * 'strict'): a token file, a split in progress and a transfer's exact request survive a crash or a power loss before the step goes on.
 * Reads are synchronous, from a copy loaded at start.
 */
import type { IdbKv } from './idb.js';

/**
 * - `planned`: a deposit intent is planned (its secret is derived, the intent high-water mark backed up); nothing is sent yet
 * - `deposited`: the deposit transaction is mined (a deposit number); `proven`: its receipt proof J is journaled
 * - `minted`: a held token, with its token file in `bytes`
 * - `splitting` / `split`: a token being / having been split into whole parts (`splitInto`)
 * - `sent`: transferred to another tab's key (`bytes` is the file addressed to it); `received`: its file, stored on arrival and not verified
 * - `burned`: burned for its return (`returnId`, the redemption ID `eta`); `redeemed`: the vault paid it
 */
export type Phase = 'planned' | 'deposited' | 'proven' | 'minted' | 'splitting' | 'split' | 'sent' | 'received' | 'burned' | 'redeemed';

/** A transfer built and stored before it is certified (the plug-in does not journal transfers). */
export interface PendingTransfer {
  /** hex CBOR: the transaction (it holds the state mask) and its signed certification request */
  tx: string;
  cd: string;
  at: number;
  toPublicKey: string;
  toProfile: string;
  /** hex: the public key that signed it */
  signer: string;
}

export interface TokenRecord {
  /** `d<intent>` for a deposit's root token, `<parent>.<n>` for a split part, `rx-…` for a received token */
  id: string;
  amountWei: string;
  phase: Phase;
  /** the deposit intent (a root token) and, once mined, the deposit number and block */
  intent?: string;
  depositNumber?: string;
  depositBlock?: string;
  depositTx?: string;
  /** hex: the receipt proof J's size, and the token (its latest file) */
  jBytes?: number;
  tokenId?: string;
  bytes?: string;
  /** the split: for the parent the part ids and their amounts, for a part the parent */
  splitInto?: string[];
  splitAmounts?: string[];
  parent?: string;
  /** the return: the plan's id (hex), the redemption ID eta, the EVM recipient, the burn index a */
  returnId?: string;
  /** set before the burn is requested, so nothing else spends the state the burn spends; cleared if the burn never got that far */
  burning?: boolean;
  eta?: string;
  recipient?: string;
  burnIndex?: string;
  /** the redeem transaction that paid it */
  redeemTx?: string;
  /** the profile it came from / went to, and the receiving key */
  from?: string;
  to?: string;
  toPublicKey?: string;
  receivedAt?: number;
  /** the last verification failure of a received token */
  verifyError?: string;
  pending?: PendingTransfer;
}

const records = new Map<string, TokenRecord>();
let kv: IdbKv | null = null;
const KEY = (id: string): string => `tok/${id}`;

/** Load the stored records (once, at start). */
export async function initTokens(store: IdbKv): Promise<void> {
  kv = store;
  records.clear();
  for (const [, v] of await store.entries('tok/')) {
    const t = JSON.parse(v) as TokenRecord;
    records.set(t.id, t);
  }
}

export const listTokens = (): TokenRecord[] => [...records.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
export const getToken = (id: string | null | undefined): TokenRecord | undefined => (id ? records.get(id) : undefined);

/** Write a record durably. The copy in memory changes first, so a reader after this call sees it even while the write is in flight. */
export async function putToken(t: TokenRecord): Promise<void> {
  records.set(t.id, t);
  if (!kv) throw new Error('the token store is not open');
  await kv.put(KEY(t.id), JSON.stringify(t));
}

/** Merge fields into a stored record (by id, never "the selected one": the selection may change while a step runs). undefined removes a field. */
export async function patchToken(id: string, patch: Partial<TokenRecord>): Promise<TokenRecord> {
  const t = getToken(id);
  if (!t) throw new Error(`no token record ${id}`);
  const next: TokenRecord = { ...t, ...patch };
  for (const k of Object.keys(patch) as (keyof TokenRecord)[]) if (patch[k] === undefined) delete next[k];
  await putToken(next);
  return next;
}
