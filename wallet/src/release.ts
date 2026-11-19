/**
 * The deployment's published files (a bft-core testnet package, GENERATION/bridge/nb2/public/, served beside the wallet): the release manifest
 * `nb2-release.json`, the trust-base bundle and its genesis-EntryID pin. They replace protocol 7's tester-config.json. The manifest holds the
 * pins the plug-in checks the deployment against (Γ, the vault's runtime code hash, the limits, the deployment block) and the plug-in commit it
 * was released with (`bridge.sources`).
 */
import type { DeploymentPins } from '@unicitylabs/native-bridge-plugin/nb2';

import { hex, unhex } from './hex.js';

export interface Release {
  pins: Record<string, unknown>;
  package?: { generation?: string; chainId?: number; genesisHash?: string; validators?: number };
  bridge?: { sources?: Record<string, string> };
  deployment?: Record<string, unknown>;
  trust?: { bundle?: string; genesisEntryId?: string };
  limits?: Record<string, { value?: unknown }>;
  envelope?: unknown;
  [k: string]: unknown;
}

const u = (v: unknown, what: string): string => {
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new Error(`nb2-release.json: pins.${what} is missing`);
  return String(v);
};

/** The wallet pins of a release manifest (spec section 4.3), as native-bridge-plugins wallet/core.ts `pinsOf` reads them. */
export function pinsOf(release: { pins: Record<string, unknown> }): DeploymentPins {
  if (typeof release.pins !== 'object' || release.pins === null) throw new Error('nb2-release.json has no pins');
  const p = release.pins;
  const build = u(p.build, 'build');
  if (build !== 'test' && build !== 'production') throw new Error(`nb2-release.json: pins.build is ${build}`);
  return {
    gamma: unhex(u(p.gamma, 'gamma')), build, vaultRuntimeCodeHash: unhex(u(p.vaultRuntimeCodeHash, 'vaultRuntimeCodeHash')),
    maxEncodedTxBytes: BigInt(u(p.maxEncodedTxBytes, 'maxEncodedTxBytes')), userGasLimit: BigInt(u(p.userGasLimit, 'userGasLimit')),
    gasReserve: BigInt(u(p.gasReserve, 'gasReserve')), returnReserveSegments: BigInt(u(p.returnReserveSegments, 'returnReserveSegments')),
    deploymentBlock: BigInt(u(p.deploymentBlock, 'deploymentBlock')), stateReadOnly: p.stateReadOnly === true,
    ...(typeof p.nativeGasSchedule === 'string' ? { nativeGasSchedule: p.nativeGasSchedule } : {}),
  };
}

export interface Published {
  release: Release;
  pins: DeploymentPins;
  /** the trust-base bundle, and the genesis EntryID the operator publishes beside it (informational: the pin the wallet uses is its own) */
  bundle: Uint8Array;
  publishedPin: string;
  /** the plug-in commit the manifest was released with */
  pluginCommit: string | null;
  url: string;
}

const get = async (url: string): Promise<Response> => {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} (is a native bridge v2 deployment published on this network?)`);
  return res;
};

/** Fetch the manifest, its trust bundle and its published pin. Files named by the manifest are relative to its URL. */
export async function fetchRelease(url: string): Promise<Published> {
  const base = new URL(url, globalThis.location?.href ?? 'http://localhost/');
  const release = (await (await get(base.href)).json()) as Release;
  const pins = pinsOf(release);
  const bundleUrl = new URL(release.trust?.bundle ?? 'trust-base.bundle.cbor', base).href;
  const bundle = new Uint8Array(await (await get(bundleUrl)).arrayBuffer());
  const pinFile = await fetch(new URL('trust-base.genesis.entryid', base).href, { cache: 'no-cache' }).then((r) => (r.ok ? r.text() : '')).catch(() => '');
  const publishedPin = (pinFile.trim() || release.trust?.genesisEntryId || '').replace(/^0x/, '').toLowerCase();
  return { release, pins, bundle, publishedPin, pluginCommit: release.bridge?.sources?.['native-bridge-plugins'] ?? null, url: base.href };
}

export const pinHex = (b: Uint8Array): string => hex(b);
