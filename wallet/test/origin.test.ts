import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_NB2_ORIGIN_BYTES } from '@unicitylabs/native-bridge-plugin/nb2';
import { OriginFeed, originFeed, readCheckpointBytes } from '../src/origin.js';
import { refreshWalletAuthority } from '../src/trust.js';
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
