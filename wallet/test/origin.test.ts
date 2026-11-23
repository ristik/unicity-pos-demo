import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import { MAX_NB2_ORIGIN_BYTES } from '@unicitylabs/native-bridge-plugin/nb2';
import { OriginFeed, originFeed, readCheckpointBytes } from '../src/origin.js';
import { refreshTrust, refreshWalletAuthority } from '../src/trust.js';
import { begin, end, installFetchTrace } from '../src/trace.js';
import { makeRoot } from './world.js';

const binding = { network: 3, generation: 'fixture', genesisHash: `0x${'ab'.repeat(32)}`, releaseSha256: 'cd'.repeat(32) };
const initial = { usableEpoch: 1n, rootRound: 100n, blockNumber: 4, blockHash: `0x${'04'.repeat(32)}` };
const document = {
  schema: 'unicity-nb2-origin', version: 1, ...binding, blockNumber: 5, blockHash: `0x${'05'.repeat(32)}`, usableEpoch: '1', rootRound: '133',
};
const url = new URL('https://test.example/release/nb2-origin.json');

test('the checkpoint feed must be on the selected authenticated release channel', () => {
  assert.equal(originFeed('https://test.example/release/nb2-release.json', 'https://test.example').href, url.href);
  assert.throws(() => originFeed('https://elsewhere.example/release/nb2-release.json', 'https://test.example'), /authenticated release origin/);
  assert.throws(() => originFeed('http://test.example/release/nb2-release.json', 'http://test.example'), /authenticated release origin/);
});

test('the wallet persists only accepted monotonic checkpoints and restores them on reload', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const trust = (await makeRoot()).trust.withAuthenticatedOrigin(initial);
  let saved: string | null = null;
  let failWrite = true;
  const store = {
    get: async (key: string) => {
      assert.equal(key, `return/origin/${binding.releaseSha256}`);
      return saved;
    },
    delete: async () => { saved = null; },
    put: async (key: string, record: string) => {
      assert.equal(key, `return/origin/${binding.releaseSha256}`);
      if (failWrite) throw new Error('durable write failed');
      saved = record;
    },
  };
  let offered = document;
  t.mock.method(globalThis, 'fetch', async (input: URL, options: RequestInit) => {
    assert.equal(input.href, url.href);
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    return Response.json(offered);
  });
  const wallet = new OriginFeed(trust, binding, initial, url, store);
  await assert.rejects(wallet.refresh(), /durable write failed/);
  assert.equal(wallet.current.origin?.rootRound, 100n);
  failWrite = false;
  now += 1_000;
  assert.equal((await wallet.refresh()).origin?.rootRound, 133n);
  assert.equal(JSON.parse(saved!).rootRound, '133');
  const reopened = new OriginFeed(trust, binding, initial, url, store);
  await reopened.restore();
  assert.equal(reopened.current.origin?.rootRound, 133n);
  const durable = saved;
  offered = { ...document, blockNumber: 6, blockHash: `0x${'06'.repeat(32)}`, rootRound: '132' };
  await assert.rejects(reopened.refresh(), /rolls back/);
  assert.equal(saved, durable);
  assert.equal(reopened.current.origin?.rootRound, 133n);
  offered = { ...document, releaseSha256: 'ef'.repeat(32) };
  now += 1_000;
  await assert.rejects(reopened.refresh(), /different release/);
  assert.equal(saved, durable);
});

test('an invalid cached checkpoint is discarded and the authenticated feed can recover Connect', async (t) => {
  const trust = (await makeRoot()).trust.withAuthenticatedOrigin(initial);
  let saved: string | null = '{"schema":"invalid"}';
  const store = {
    get: async () => saved,
    put: async (_key: string, value: string) => { saved = value; },
    delete: async () => { saved = null; },
  };
  const feed = new OriginFeed(trust, binding, initial, url, store);
  assert.equal(await feed.restore(), false);
  assert.equal(saved, null);
  assert.equal(feed.current.origin?.rootRound, initial.rootRound);
  t.mock.method(globalThis, 'fetch', async () => Response.json(document));
  const refreshed = await refreshWalletAuthority(trust, async () => { throw new Error('UTB HTTP 503'); }, feed, initial.rootRound);
  assert.equal(refreshed.historyFailed, true);
  assert.equal(refreshed.checkpointFailed, false);
  assert.equal(refreshed.trust.origin?.rootRound, 133n);
  assert.equal(JSON.parse(saved!).rootRound, '133');
});

test('a persisted B1 advance returns while the UTB transport is stalled', { timeout: 2_000 }, async (t) => {
  const trust = (await makeRoot()).trust.withAuthenticatedOrigin(initial);
  const agg = new AggregatorClient('https://test.example/aggregator');
  const deadline = new AbortController();
  t.after(() => deadline.abort());
  let saved = false;
  let sawAbort = false;
  let originRequests = 0;
  const store = {
    get: async () => null,
    put: async () => { saved = true; },
    delete: async () => {},
  };
  const feed = new OriginFeed(trust, binding, initial, url, store);
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === url.href) { originRequests++; return Response.json(document); }
    assert.match(String(input), /\/api\/v1\/trustbases/);
    assert.equal(init?.signal, deadline.signal);
    // The upstream request never responds. Only its own transport signal can settle it.
    return new Promise<Response>((_resolve, reject) => {
      deadline.signal.addEventListener('abort', () => {
        sawAbort = true;
        reject(deadline.signal.reason);
      }, { once: true });
    });
  });
  const pending = refreshTrust(trust, agg, deadline.signal);
  const refreshing = () => refreshTrust(feed.current, agg);
  const refreshed = await refreshWalletAuthority(trust, refreshing, feed, initial.rootRound);
  assert.equal(sawAbort, false);
  assert.equal(saved, true);
  assert.equal(refreshed.checkpointFailed, false);
  assert.equal(refreshed.trust.origin?.rootRound, 133n);
  assert.equal(refreshed.trust.history, trust.history);
  assert.equal(refreshing(), pending, 'the successor shares the running UTB update');
  assert.equal((await refreshWalletAuthority(trust, refreshing, feed, initial.rootRound)).trust, refreshed.trust);
  assert.equal(originRequests, 1, 'a covering held checkpoint can be returned without another fetch');
  deadline.abort();
  await assert.rejects(pending);
  assert.equal(sawAbort, true);
  assert.equal(feed.current, refreshed.trust);
});

test('an origin appearing just after a stale poll is accepted on the next one-second poll', { timeout: 3_000 }, async (t) => {
  const trust = (await makeRoot()).trust.withAuthenticatedOrigin(initial);
  const store = { get: async () => null, put: async () => {}, delete: async () => {} };
  const feed = new OriginFeed(trust, binding, initial, url, store);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json(++requests === 1
    ? { ...document, ...initial, usableEpoch: '1', rootRound: '100' } : document));
  await feed.refresh();
  let finishHistory!: () => void;
  const history = new Promise<void>((resolve) => { finishHistory = resolve; });
  try {
    const result = await refreshWalletAuthority(trust, () => history, feed, initial.rootRound);
    assert.equal(result.trust.origin?.rootRound, 133n);
    assert.equal(requests, 2);
  } finally {
    finishHistory();
  }
});

test('bursts share one request and the feed backs off on replay and errors up to four seconds', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const trust = (await makeRoot()).trust.withAuthenticatedOrigin(initial);
  const store = { get: async () => null, put: async () => {}, delete: async () => {} };
  const feed = new OriginFeed(trust, binding, initial, url, store);
  const old = { ...document, ...initial, usableEpoch: '1', rootRound: '100' };
  let requests = 0;
  let reply!: (res: Response) => void;
  const first = new Promise<Response>((resolve) => { reply = resolve; });
  t.mock.method(globalThis, 'fetch', async () => {
    switch (++requests) {
      case 1: return first;
      case 2: return new Response(null, { status: 503 });
      case 5:
      case 6: return Response.json(document);
      default: return Response.json(old);
    }
  });
  const burst = () => Array.from({ length: 12 }, () => feed.refresh());
  const inFlight = burst();
  assert.equal(requests, 1);
  reply(Response.json(old));
  await Promise.all(inFlight);
  now = 999;
  await Promise.all(burst());
  assert.equal(requests, 1);
  now = 1_000;
  assert.ok((await Promise.allSettled(burst())).every((attempt) => attempt.status === 'rejected'));
  assert.equal(requests, 2);
  for (const [early, due, count] of [[2_999, 3_000, 3], [6_999, 7_000, 4], [10_999, 11_000, 5], [11_999, 12_000, 6]]) {
    now = early;
    await Promise.all(burst());
    assert.equal(requests, count - 1);
    now = due;
    await Promise.all(burst());
    assert.equal(requests, count);
  }
  assert.equal(feed.current.origin?.rootRound, 133n);
});

test('checkpoint transport enforces the decoded byte cap before buffering an oversized chunk', async (t) => {
  let chunks = 0;
  let canceled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const size = ++chunks === 1 ? MAX_NB2_ORIGIN_BYTES - 1 : 2;
      controller.enqueue(new Uint8Array(size));
    },
    cancel() { canceled = true; },
  }), { headers: { 'content-length': '16' } });
  t.mock.method(response, 'clone', () => { throw new Error('trace must leave streamed bodies untouched'); });
  t.mock.method(globalThis, 'fetch', async () => response);
  installFetchTrace();
  const trace = begin();
  try {
    await assert.rejects(readCheckpointBytes(await fetch(url)), /checkpoint exceeds 4096 bytes/);
  } finally {
    end(trace);
  }
  assert.ok(canceled);
  assert.equal(trace.calls.length, 1);
});
