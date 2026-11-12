/**
 * What replacing this tab's key would put out of reach: the old key is the only stored copy of its secret. `null` for a balance or credit
 * means it could not be read, and is taken as value held.
 */
import { fmtUnits } from './hex.js';
import type { TokenRecord } from './tokens.js';

export interface KeyHoldings {
  /** the old key's EVM address */
  address: string;
  /** EVM balance in wei, or null when it could not be read */
  balance: bigint | null;
  /** unclaimed vault credit of the address, or null when it could not be read */
  credit: bigint | null;
  tokens: TokenRecord[];
}

/** One line per thing of value only the old key can use; empty when nothing would be lost. */
export function valueAtRisk(k: KeyHoldings): string[] {
  const out: string[] = [];
  if (k.balance === null) out.push('the EVM balance could not be read (assume it holds UCT)');
  else if (k.balance > 0n) out.push(`EVM balance ${fmtUnits(k.balance)} UCT`);
  if (k.credit === null) out.push('the vault credit could not be read (assume there is some)');
  else if (k.credit > 0n) out.push(`unclaimed vault credit ${fmtUnits(k.credit)} UCT (only this address can claim it)`);
  for (const t of k.tokens) {
    const amount = `${fmtUnits(BigInt(t.amountWei))} UCT`;
    if (t.phase === 'minted') out.push(`token ${t.id} (${amount}) is held by this key`);
    else if (t.phase === 'received') out.push(`received token ${t.id} (${amount}, not verified yet) is addressed to this key`);
    else if ((t.phase === 'burned' || t.phase === 'enveloped') && t.recipient?.toLowerCase() === k.address.toLowerCase()) {
      out.push(`burned token ${t.id} (${amount}) will credit this key's address ${t.recipient}: only this key can claim it`);
    }
  }
  return out;
}

/** The typed confirmation an import needs when valueAtRisk is not empty. */
export const CONFIRM_WORD = 'replace';
export const confirmed = (typed: string | null): boolean => (typed ?? '').trim().toLowerCase() === CONFIRM_WORD;
