/**
 * Where the PoS contracts are. Custody, election and the reward pool are the generation's `network/pos-deployment.json` (the same addresses on
 * tn-pos-staging-20261111 and tn-pos-dev-20261112: the factory deploys deterministically); the registry is the fixed system address. The reader,
 * the evidence module and the policy source are read from the election itself. Overrides: build-time VITE_POS_* or the page's query string
 * (`?custody=0x…&election=0x…&rewardPool=0x…`). The trust pin is the wallet's (src/config.ts): there is no `?pin=`.
 */
import { isAddress } from '../evm.js';
import type { Addresses } from './chain.js';

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const query = (): URLSearchParams => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '');
  } catch {
    return new URLSearchParams();
  }
};

const pick = (name: string, envName: string, fallback: string): string => {
  const v = query().get(name) ?? env[envName] ?? fallback;
  if (!isAddress(v)) throw new Error(`${name}: not an address: ${v}`);
  return v;
};

export function posAddresses(): Addresses {
  return {
    registry: pick('registry', 'VITE_POS_REGISTRY', '0xff00000000000000000000000000000000000002'),
    custody: pick('custody', 'VITE_POS_CUSTODY', '0xc399A50Da6437b10e26AEf8DB67EB7f79f8f1D93'),
    election: pick('election', 'VITE_POS_ELECTION', '0x051A08C2e5262403690784A4FF712809d55A53c3'),
    rewardPool: pick('rewardPool', 'VITE_POS_REWARD_POOL', '0x0b53591d38dcc0367938D4B2738a9BFC27eE7b48'),
    // discovered from the election
    reader: '',
    evidence: '',
    governance: '',
  };
}

/** Poll cadence: the cheap clock every POLL_MS, everything else when it changed or every SLOW_MS (public gateway: ~5 req/s per IP). */
export const POLL_MS = Number(query().get('poll') ?? env.VITE_POS_POLL_MS ?? 8000);
export const SLOW_MS = 30_000;
export const TRUST_MS = 20_000;
export const PARAMS_MS = 300_000;
export const SPACING_MS = 250;
