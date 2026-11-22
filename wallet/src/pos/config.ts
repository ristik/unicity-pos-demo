/**
 * Where the PoS contracts are. Supply the generation's custody, election and reward pool from its deployment manifest. The VR module also discovers custody and election. The reader,
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
  if (v !== '' && !isAddress(v)) throw new Error(`${name}: not an address: ${v}`);
  return v;
};

export function posAddresses(): Addresses {
  return {
    registry: pick('registry', 'VITE_POS_REGISTRY', '0xff00000000000000000000000000000000000002'),
    custody: pick('custody', 'VITE_POS_CUSTODY', ''),
    election: pick('election', 'VITE_POS_ELECTION', ''),
    rewardPool: pick('rewardPool', 'VITE_POS_REWARD_POOL', ''),
    // the validator registry, a fixed system address; the module and the governor are read from it
    vr: pick('vr', 'VITE_POS_VR', '0xff00000000000000000000000000000000000003'),
    poa: '',
    multisig: '',
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
