/** The wallet's token records (localStorage): one per lock, carrying the token file and what each step produced. */
import { loadJson, saveJson } from './store.js';

export type Phase = 'locked' | 'proved' | 'minted' | 'sent' | 'burned' | 'enveloped' | 'redeemed';

export interface TokenRecord {
  /** the lock nonce, or `rx-<token id>` for a token received from another tab */
  id: string;
  nonce: string;
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
  /** the profile it came from / went to */
  from?: string;
  to?: string;
}

export const listTokens = (): TokenRecord[] => loadJson<TokenRecord[]>('tokens', []);

export function putToken(t: TokenRecord): void {
  const all = listTokens().filter((x) => x.id !== t.id);
  saveJson('tokens', [...all, t]);
}

export const getToken = (id: string | null): TokenRecord | undefined => listTokens().find((t) => t.id === id);
