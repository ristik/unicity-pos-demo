/**
 * What replacing this tab's key would put out of reach: the old key is the only stored copy of its secret, and a deposit's secret, the bridge key
 * and every token's owner key derive from it. `null` for a balance means it could not be read, and is taken as value held.
 */
import { fmtUnits } from './hex.js';
import type { TokenRecord } from './tokens.js';

export interface KeyHoldings {
  /** the old key's EVM address */
  address: string;
  /** EVM balance in wei, or null when it could not be read */
  balance: bigint | null;
  tokens: TokenRecord[];
}

/** One line per thing of value only the old key can use; empty when nothing would be lost. */
export function valueAtRisk(k: KeyHoldings): string[] {
  const out: string[] = [];
  if (k.balance === null) out.push('the EVM balance could not be read (assume it holds UCT)');
  else if (k.balance > 0n) out.push(`EVM balance ${fmtUnits(k.balance)} UCT`);
  for (const t of k.tokens) {
    const amount = `${fmtUnits(BigInt(t.amountWei))} UCT`;
    switch (t.phase) {
      case 'planned':
      case 'deposited':
      case 'proven':
        out.push(`deposit ${t.id} (${amount}) is not minted yet (${t.phase}): its secret derives from this key, and only this key can mint it`);
        break;
      case 'minted':
      case 'splitting':
        out.push(`token ${t.id} (${amount}) is held by this key`);
        break;
      case 'received':
        out.push(`received token ${t.id} (${amount}, not verified yet) is addressed to this key`);
        break;
      case 'burned':
        if (t.recipient?.toLowerCase() === k.address.toLowerCase()) out.push(`burned token ${t.id} (${amount}) is not redeemed yet: it pays this key's address ${t.recipient}, and only this wallet's journal can build the redeem`);
        break;
      default:
    }
    if (t.pending) out.push(`a transfer of token ${t.id} (${amount}) is stored and not certified yet`);
  }
  return out;
}

/** The typed confirmation an import needs when valueAtRisk is not empty. */
export const CONFIRM_WORD = 'replace';
export const confirmed = (typed: string | null): boolean => (typed ?? '').trim().toLowerCase() === CONFIRM_WORD;
