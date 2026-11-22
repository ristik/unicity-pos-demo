/**
 * Where everything is. The demo is served from the network's own origin, so every endpoint is a same-origin path (no CORS); the bridge's
 * pins and files come from the deployment's published nb2-release.json (with its trust-base bundle and pin), whose own URLs are shown but not
 * used. Overrides (the settings panel) are kept per profile in localStorage.
 */
import { loadJson, saveJson } from './store.js';

export interface Settings {
  rpc: string;
  aggregator: string;
  /** the faucet's API root: GET <faucet>/network, POST <faucet>/claim */
  faucet: string;
  /** the deployment's native bridge v2 release manifest; its trust bundle and pin file are read beside it */
  release: string;
  /**
   * The genesis EntryID the trust history is pinned to. It comes from the build (VITE_TRUST_PIN, wallet/.env.production) and is never taken
   * from the server: with none, the wallet refuses to connect. The settings panel can override it (a labelled developer option).
   */
  trustPin: string;
  /** the root network id (the trust history's; staging: 3) */
  network: number;
}

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

export const RELEASE_DIGEST = (env.VITE_NB2_RELEASE_SHA256 ?? '').trim().toLowerCase();

export const DEFAULTS: Settings = {
  rpc: '/rpc',
  aggregator: '/aggregator',
  faucet: '/faucet/api',
  release: env.VITE_NB2_RELEASE ?? '/release/nb2-release.json',
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
