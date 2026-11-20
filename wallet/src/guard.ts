/** Which steps the page may run, and when: read-only by default, mutations only once the lock, the durable key and the records are ready. */

/** The steps that move nothing and may run on a page that is not the profile's writer. */
export const READ_ONLY_OK: ReadonlySet<string> = new Set(['connect', 'balance', 'trust', 'check', 'faucet-load', 'faucet']);

/** The steps that move value or certify something: the session's pinned deployment is checked again right before each (as the reference wallet does). */
export const VALUE_STEPS: ReadonlySet<string> = new Set(['deposit', 'mint', 'split', 'transfer', 'plan', 'burn', 'redeem', 'fund']);

export interface GuardState {
  /** why the wallet will not move value, or null */
  storeProblem: string | null;
  /** the lock, the key, the records, any recovery and the reconciliation are done */
  ready: boolean;
  /** records of an older build are present: only a reset may run */
  legacy: boolean;
}

/** Why STEP may not run now, or null. The initial state is not ready: everything that writes is refused until start() and connect() have finished. */
export function refusal(step: string, g: GuardState): string | null {
  if (READ_ONLY_OK.has(step)) return null;
  if (step === 'reset' && g.legacy) return null;
  return g.storeProblem ?? (g.ready ? null : 'the wallet is not ready yet (the writer lock, the key, connect, recovery and reconciliation come first)');
}
