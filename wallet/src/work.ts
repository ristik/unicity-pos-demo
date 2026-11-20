/**
 * What a profile's durable store holds that must not be thrown away: a scan of EVERY deployment-and-key scope's token records and every
 * plug-in journal in it (not only the page's active scope), and the records an older build wrote without a scope. Used by key import and reset.
 */
import type { IdbKv } from './idb.js';
import { fmtUnits } from './hex.js';
import type { TokenRecord } from './tokens.js';

export interface Scan {
  /** keys `tok/<id>` of a build before records were scoped: not read by this build */
  legacy: string[];
  /** one line per unfinished piece of work, in any scope or journal */
  unfinished: string[];
  /** every scoped token record, with its scope */
  records: (TokenRecord & { scope: string })[];
}

const where = (scope: string): string => `[${scope.slice(0, 8)}…]`;

/** The unfinished work a token record stands for ('' when none). */
export function unfinishedOf(t: TokenRecord): string[] {
  const a = `${fmtUnits(BigInt(t.amountWei))} UCT`;
  const out: string[] = [];
  if (t.phase === 'planned' || t.phase === 'deposited' || t.phase === 'proven') out.push(`deposit ${t.id} (${a}) is not minted yet: only this key can mint it`);
  if (t.phase === 'splitting') out.push(`the split of ${t.id} (${a}) is not finished`);
  if (t.pending) out.push(`a transfer of token ${t.id} (${a}) is stored and not certified yet`);
  if (t.burning) out.push(`the burn of token ${t.id} (${a}) was requested and its result is not recorded`);
  if (t.phase === 'burned') out.push(`the burn of token ${t.id} (${a}) is not redeemed yet`);
  if (t.phase === 'received') out.push(`received token ${t.id} (${a}) is not verified yet`);
  return out;
}

export async function scanProfile(kv: IdbKv): Promise<Scan> {
  const legacy: string[] = [];
  const unfinished: string[] = [];
  const records: Scan['records'] = [];
  for (const [key, text] of await kv.entries('tok/')) {
    const parts = key.split('/');
    if (parts.length === 2) {
      legacy.push(key);
      continue;
    }
    const t = JSON.parse(text) as TokenRecord;
    records.push({ ...t, scope: parts[1] });
    for (const line of unfinishedOf(t)) unfinished.push(`${where(parts[1])} ${line}`);
  }
  // the plug-in's journals (nb2/v1/<D>/...): a deposit not minted, a split or return that is past its plan and not finished
  for (const [key, text] of await kv.entries('nb2/v1/')) {
    let r: { kind?: string; status?: string };
    try {
      r = JSON.parse(text);
    } catch {
      continue;
    }
    const d = key.split('/')[2] ?? '?';
    if (r.kind === 'deposit' && r.status !== 'minted') unfinished.push(`${where(d)} journal: deposit ${key.split('/').pop()} is ${r.status}`);
    if (r.kind === 'split' && r.status !== 'minted' && r.status !== 'planned') unfinished.push(`${where(d)} journal: a split is ${r.status}`);
    if (r.kind === 'return' && r.status !== 'paid' && r.status !== 'planned') unfinished.push(`${where(d)} journal: a return is ${r.status}`);
  }
  return { legacy, unfinished: [...new Set(unfinished)], records };
}
