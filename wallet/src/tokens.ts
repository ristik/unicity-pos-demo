/** The wallet's token records (localStorage): one per lock, carrying the token file and what each step produced. */
import { loadJson, saveJson } from './store.js';

/** `received`: a token file from another tab, stored on arrival and not yet verified. */
export type Phase = 'locked' | 'proved' | 'minted' | 'sent' | 'received' | 'burned' | 'enveloped' | 'redeemed';

export interface TokenRecord {
  /** the lock nonce, or `rx-…` for a token received from another tab */
  id: string;
  /** the lock nonce ('' for a received token until it is verified) */
  nonce: string;
  /** for a received token not yet verified: the amount the sender claims */
  amountWei: string;
  phase: Phase;
  tokenId?: string;
  lockTx?: string;
  lockBlockHash?: string;
  /** hex: the lock proof, the token file (latest), the return envelope */
  lockProof?: string;
  bytes?: string;
  envelope?: string;
  recipient?: string;
  redeemTx?: string;
  /** the profile it came from / went to, and the receiving key */
  from?: string;
  to?: string;
  toPublicKey?: string;
  receivedAt?: number;
  /** the last verification failure of a received token */
  verifyError?: string;
  /**
   * A transfer or burn built and stored before it is submitted (hex CBOR of the transaction, which holds its state mask, and of the signed
   * certification request). While it is set, the step resumes this transaction and never builds another.
   */
  pending?: { kind: 'transfer' | 'burn'; tx: string; cd: string; at: number; toPublicKey?: string; recipient?: string };
}

export const listTokens = (): TokenRecord[] => loadJson<TokenRecord[]>('tokens', []);

export function putToken(t: TokenRecord): void {
  const all = listTokens().filter((x) => x.id !== t.id);
  saveJson('tokens', [...all, t]);
}

export const getToken = (id: string | null): TokenRecord | undefined => listTokens().find((t) => t.id === id);

/** Merge fields into a stored record (by id, never "the selected one": the selection may change while a step runs). */
export function patchToken(id: string, patch: Partial<TokenRecord>): TokenRecord {
  const t = getToken(id);
  if (!t) throw new Error(`no token record ${id}`);
  const next = { ...t, ...patch };
  for (const k of Object.keys(patch) as (keyof TokenRecord)[]) if (patch[k] === undefined) delete next[k];
  putToken(next);
  return next;
}
