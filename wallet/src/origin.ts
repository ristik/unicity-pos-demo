import {
  MAX_NB2_ORIGIN_BYTES, Nb2Error, refreshNb2Origin, type Nb2OriginBinding, type Nb2OriginCheckpoint, type TrustInput,
} from '@unicitylabs/native-bridge-plugin/nb2';
import { sleep } from './hex.js';
import type { IdbKv } from './idb.js';
import type { Published } from './release.js';

export const CHECKPOINT_PATH = '/release/nb2-origin.json';
const utf8 = new TextEncoder();
const REFRESH_WAIT_MS = 80_000;
const REFRESH_INTERVAL_MS = 4_000;

type Store = Pick<IdbKv, 'get' | 'put' | 'delete'>;

/** A certificate ahead of the installed B1 origin can become eligible after the operator publishes its next checkpoint. */
export function isOriginAhead(error: unknown): boolean {
  for (let e = error; e instanceof Nb2Error; e = e.inner) {
    if (e.rule === 'SealEpoch' && e.message.endsWith('seal exceeds the authenticated B1 origin')) return true;
  }
  return false;
}

/** The build selects the HTTPS channel. Tests explicitly use an authenticated loopback relay of that channel. */
export function originFeed(release: string, channel: string): URL {
  const base = new URL(release);
  const expected = new URL(channel);
  const loopback = expected.protocol === 'http:' && expected.hostname === '127.0.0.1';
  if ((expected.protocol !== 'https:' && !loopback) || expected.origin !== base.origin || base.username || base.password) {
    throw new Error('The B1 checkpoint feed must use the build’s authenticated release origin.');
  }
  return new URL(CHECKPOINT_PATH, base);
}

export function releaseCheckpoint(published: Published, trust: TrustInput, digest: string): {
  binding: Nb2OriginBinding; checkpoint: Nb2OriginCheckpoint;
} {
  const { generation, genesisHash } = published.release.package ?? {};
  const anchor = published.release.trust?.origin as { blockHash?: unknown; blockNumber?: unknown } | undefined;
  if (!generation || !genesisHash || !trust.origin || typeof anchor?.blockHash !== 'string' ||
      typeof anchor.blockNumber !== 'number' || published.sha256 !== digest) {
    throw new Error('The authenticated release is missing its B1 checkpoint binding.');
  }
  const binding = { network: Number(trust.network.id), generation, genesisHash, releaseSha256: digest };
  const checkpoint = { ...trust.origin, blockHash: anchor.blockHash, blockNumber: anchor.blockNumber };
  // Validate the bootstrap under the same rules as the feed before accepting any saved or network checkpoint.
  refreshNb2Origin(trust, binding, checkpoint, utf8.encode(JSON.stringify({
    schema: 'unicity-nb2-origin', version: 1, ...binding, ...checkpoint,
    usableEpoch: String(checkpoint.usableEpoch), rootRound: String(checkpoint.rootRound),
  })));
  return { binding, checkpoint };
}

/** Fetch supplies decoded bytes. Reject an oversized chunk before copying it into the bounded buffer. */
export async function readCheckpointBytes(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('B1 checkpoint feed returned an empty body.');
  const bytes = new Uint8Array(MAX_NB2_ORIGIN_BYTES);
  let used = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return bytes.subarray(0, used);
      if (value.length > bytes.length - used) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`B1 checkpoint exceeds ${MAX_NB2_ORIGIN_BYTES} bytes.`);
      }
      bytes.set(value, used);
      used += value.length;
    }
  } finally {
    reader.releaseLock();
  }
}

export class OriginFeed {
  private held: Nb2OriginCheckpoint;
  private accepting: Promise<void> = Promise.resolve();
  private fetchedAt = 0;
  private trust: TrustInput;
  private readonly key: string;

  constructor(
    trust: TrustInput, private readonly binding: Nb2OriginBinding, checkpoint: Nb2OriginCheckpoint,
    private readonly url: URL, private readonly store: Store,
  ) {
    this.trust = trust;
    this.held = checkpoint;
    this.key = `return/origin/${binding.releaseSha256}`;
  }

  get current(): TrustInput { return this.trust; }
  get checkpoint(): Nb2OriginCheckpoint { return this.held; }

  /** A corrupt cache cannot replace the release checkpoint or block a fetch from the authenticated feed. */
  async restore(): Promise<boolean> {
    const saved = await this.store.get(this.key);
    if (saved === null) return true;
    try {
      await this.accept(utf8.encode(saved), false);
      return true;
    } catch {
      await this.store.delete(this.key);
      return false;
    }
  }

  private async accept(bytes: Uint8Array, persist: boolean): Promise<void> {
    const pending = this.accepting.then(async () => {
      const { trust, checkpoint } = refreshNb2Origin(this.trust, this.binding, this.held, bytes);
      if (checkpoint.blockNumber === this.held.blockNumber) return;
      if (persist) {
        await this.store.put(this.key, JSON.stringify({
          schema: 'unicity-nb2-origin', version: 1, ...this.binding, ...checkpoint,
          usableEpoch: String(checkpoint.usableEpoch), rootRound: String(checkpoint.rootRound),
        }));
      }
      this.trust = trust;
      this.held = checkpoint;
    });
    this.accepting = pending.catch(() => undefined);
    await pending;
  }

  async refresh(waitForAdvance = false, waitMs = REFRESH_WAIT_MS): Promise<TrustInput> {
    if (globalThis.navigator?.onLine === false) return this.trust;
    const previous = this.held.rootRound;
    const deadline = performance.now() + waitMs;
    for (;;) {
      if (performance.now() - this.fetchedAt >= REFRESH_INTERVAL_MS || this.fetchedAt === 0) {
        const res = await fetch(this.url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`B1 checkpoint feed returned HTTP ${res.status}.`);
        await this.accept(await readCheckpointBytes(res), true);
        this.fetchedAt = performance.now();
      }
      if (!waitForAdvance || this.held.rootRound > previous) return this.trust;
      const remaining = deadline - performance.now();
      if (remaining <= 0) return this.trust;
      await sleep(Math.min(REFRESH_INTERVAL_MS, remaining));
    }
  }
}
