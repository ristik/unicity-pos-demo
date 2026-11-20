/** Which steps the page may run, and when: read-only by default, mutations only once the lock, the durable key and the records are ready. */

/** The steps that move nothing and may run on a page that is not the profile's writer. */
export const READ_ONLY_OK: ReadonlySet<string> = new Set(['connect', 'balance', 'trust', 'check']);
/** Steps that need the key to be durable (this page the profile's writer), but not the bridge: the faucet pays the key's address. */
export const KEY_ONLY: ReadonlySet<string> = new Set(['faucet-load', 'faucet']);

/** The steps that move value or certify something: the session's pinned deployment is checked again right before each (as the reference wallet does). */
export const VALUE_STEPS: ReadonlySet<string> = new Set(['deposit', 'mint', 'split', 'transfer', 'plan', 'burn', 'redeem', 'fund']);

export interface GuardState {
  /** why the wallet will not move value, or null */
  storeProblem: string | null;
  /** the lock, the key, the records, any recovery and the reconciliation are done */
  ready: boolean;
  /** records of an older build are present: only a reset may run */
  legacy: boolean;
  /** the key is committed durably and this page is the writer */
  keyDurable: boolean;
}

/** Why STEP may not run now, or null. The initial state is not ready: everything that writes is refused until start() and connect() have finished. */
export function refusal(step: string, g: GuardState): string | null {
  if (READ_ONLY_OK.has(step)) return null;
  if (KEY_ONLY.has(step)) return g.keyDurable ? null : 'the faucet pays this key\'s address: it is available only once the key is durable and this page is the profile\'s writer';
  if (step === 'reset' && g.legacy) return null;
  return g.storeProblem ?? (g.ready ? null : 'the wallet is not ready yet (the writer lock, the key, connect, recovery and reconciliation come first)');
}

/**
 * Key import is allowed only into an EMPTY profile (no record of any kind under any prefix besides the key itself and no handoff announced in this
 * page's lifetime): nothing of value can be stranded, and no sender can hold an announcement of the key being retired. Else: a new profile.
 */
export function importBlock(keys: string[], legacy: boolean, handoffAnnounced: boolean): string | null {
  const used = keys.filter((k) => k !== 'secret/key');
  if (!used.length && !legacy && !handoffAnnounced) return null;
  const why = used.includes('handoff/announced') ? 'this profile has announced its key to other tabs (a sender may hold it)' : used.length ? `this profile holds ${used.length} record${used.length === 1 ? '' : 's'}` : handoffAnnounced ? 'this page has taken part in a handoff (reload the page first)' : 'this profile holds records of an older build';
  return `a key can be imported only into an empty profile that has not announced itself in this page's lifetime (${why}): use a new profile (?w=...) to import`;
}

/** One operation at a time: key import, handoff opt-in and every step go through it, so none can interleave with another. */
export class OperationGuard {
  busy: string | null = null;
  tryEnter(key: string): boolean {
    if (this.busy !== null) return false;
    this.busy = key;
    return true;
  }
  leave(): void {
    this.busy = null;
  }
}
