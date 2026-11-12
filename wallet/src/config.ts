/**
 * Where everything is. The demo is served from the network's own origin, so every endpoint is a same-origin path (no CORS); the bridge's
 * addresses and files come from the operator-published tester-config.json (nbp tester/README.md), whose own URLs are shown but not used.
 * Overrides (the settings panel) are kept per profile in localStorage.
 */
import { isAddress } from './evm.js';
import { loadJson, saveJson } from './store.js';

export interface Settings {
  rpc: string;
  aggregator: string;
  lockproof: string;
  /** the faucet's API root: GET <faucet>/network, POST <faucet>/claim */
  faucet: string;
  testerConfig: string;
  /**
   * The genesis EntryID the trust history is pinned to. It comes from the build (VITE_TRUST_PIN, wallet/.env.production) and is never taken
   * from the server: with none, the wallet refuses to connect. The settings panel can override it (a labelled developer option).
   */
  trustPin: string;
  /** the root network id (the trust history's; staging: 3) */
  network: number;
}

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

export const DEFAULTS: Settings = {
  rpc: '/rpc',
  aggregator: '/aggregator',
  lockproof: '/lockproof',
  faucet: '/api',
  testerConfig: env.VITE_TESTER_CONFIG ?? '/bridge/tester-config.json',
  trustPin: (env.VITE_TRUST_PIN ?? '').trim(),
  network: Number(env.VITE_NETWORK_ID ?? 3),
};

/** True when the settings panel replaces the build's trust pin (shown on the page as a developer override). */
export const pinOverridden = (s: Settings): boolean => s.trustPin !== DEFAULTS.trustPin;

export const loadSettings = (): Settings => ({ ...DEFAULTS, ...loadJson<Partial<Settings>>('settings', {}) });
export const saveSettings = (s: Partial<Settings>): void => {
  saveJson('settings', s);
};

/** An absolute URL for a configured path (the SDK's aggregator client needs one). */
export const abs = (p: string): string => new URL(p, globalThis.location?.href ?? 'http://localhost/').href;

/** What an operator publishes (nbp tester/core.ts TesterConfig). Files are relative to the config's URL. */
export interface TesterConfig {
  ethUrl: string;
  redeemEthUrl?: string;
  aggUrl: string;
  lockProofUrl: string;
  chainId: number;
  genesisHash: string;
  vault: string;
  files: { trustBundle: string; trustEntryId: string; evmPdr: string; deployment: string };
}

export function checkTesterConfig(c: TesterConfig, where: string): TesterConfig {
  const bad = (what: string): never => {
    throw new Error(`${where}: ${what}`);
  };
  if (!Number.isSafeInteger(c.chainId) || c.chainId <= 0) bad('chainId must be a positive integer');
  if (typeof c.genesisHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(c.genesisHash)) bad('genesisHash must be a 0x 32-byte hash');
  if (!isAddress(c.vault)) bad('vault must be a 0x address');
  for (const k of ['trustBundle', 'trustEntryId', 'evmPdr', 'deployment'] as const) if (typeof c.files?.[k] !== 'string') bad(`files.${k} is missing`);
  return c;
}

export async function fetchTesterConfig(url: string): Promise<{ cfg: TesterConfig; fileUrl: (name: keyof TesterConfig['files']) => string }> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} (is the bridge published on this network?)`);
  const cfg = checkTesterConfig((await res.json()) as TesterConfig, url);
  const base = abs(url);
  return { cfg, fileUrl: (name) => new URL(cfg.files[name], base).href };
}
