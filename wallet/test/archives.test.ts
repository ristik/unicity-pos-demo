import assert from 'node:assert/strict';
import { test } from 'node:test';
import { archiveRpc, readPayerPolicy } from '../src/recovery.js';
import { begin, end, installFetchTrace } from '../src/trace.js';

const readArchives = (archives: string[]) => readPayerPolicy(JSON.stringify({
  signedBytes: 123, calldataBytes: 100, gas: '10', maxNonce: '1',
  maxFeePerGas: '1', maxPriorityFeePerGas: '0', feeBudget: '10', archives,
})).archives;

test('archive policy accepts public origins and a fixed same-origin proxy', () => {
  assert.deepEqual(readArchives(['https://archive.example/', '/archive-rpc']), ['https://archive.example', '/archive-rpc']);
  for (const forbidden of ['https://archive.example/key-secret', 'https://person:pw@archive.example', 'https://archive.example/?key=secret',
    'https://archive.example/#secret', '//archive.example', '/archive-rpc/secret', 'http://archive.example']) {
    assert.throws(() => readArchives([forbidden]), (error: Error) =>
      error.message.includes('public HTTPS origin') && !error.message.includes(forbidden));
  }
  assert.throws(() => readPayerPolicy('{invalid key-secret'), /^Error: Invalid return payer policy JSON\.$/);
});

test('archive RPC failures retain stable classifications and discard provider text and data', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    error: { code: -32000, message: 'too many results and unknown block: provider-marker', data: 'private-value' },
  }));
  await assert.rejects(archiveRpc('/archive-rpc').call('eth_getLogs', []), (error: Error & { code?: number; data?: unknown }) => {
    assert.equal(error.code, -32000);
    assert.match(error.message, /too many log results and pruned evidence/);
    assert.doesNotMatch(error.message, /provider-marker|private-value/);
    assert.equal(error.data, undefined);
    return true;
  });
});

test('archive traces omit endpoint, payload and response credentials', async () => {
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (): Promise<Response> => new Response('{"error":"private-response"}', { headers: { 'content-type': 'application/json' } });
  installFetchTrace();
  const trace = begin();
  try {
    const init = { method: 'POST', body: '{"method":"eth_call","params":["private-params"]}' };
    await fetch('https://username:password@archive.example/private-path?key=private-query', init);
    await fetch('/archive-rpc', init);
  } finally {
    end(trace);
    globalThis.fetch = fetchBefore;
  }
  assert.deepEqual(trace.calls.map((call) => call.url), ['other endpoint', '/archive-rpc']);
  assert.ok(trace.calls.every((call) => call.method === 'eth_call' && !call.params));
  assert.doesNotMatch(JSON.stringify(trace), /private-|username|password|archive.example/);
});
