import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import {
  EvmReader, RecoveryAuthority, RecoverySession, RpcError, TEST_PARAMS, TOPIC, buildHistory, decodeSignedTx,
  evidenceOf, recoveryRpcSource, verifyReturn, verdictAbi,
  type JsonRpc, type GasModel, type RecoveryEvent,
} from '@unicitylabs/native-bridge-plugin/nb2';
import { DEFAULTS } from '../src/config.js';
import { eqBytes as eq, hex, unhex } from '../src/hex.js';
import { IdbKv } from '../src/idb.js';
import { burnerFrom } from '../src/keys.js';
import { begin, end, installFetchTrace, reportStepFailure } from '../src/trace.js';
import * as nb2 from '../src/nb2.js';
import { caps, recoveryFixture, selector } from './recovery-world.js';
import { key } from './world.js';

const hx = (b: Uint8Array) => `0x${hex(b)}`;

const isSegmentLookup = (method: string, params: unknown[]): boolean =>
  method === 'eth_getLogs' && (params[0] as { topics?: string[] }).topics?.[0] === hx(TOPIC.SegmentSealed);

const gas: GasModel = { name: 'fixture without ordinary admission', depositGasLimit: () => 1_000_000n, redeemGasLimit: () => null };

test('continuation waits for finalized import, resumes the exact signed bytes and reaches certified Paid', async () => {
  const { root, cfg, chain, deployment, recovery, aggregator, rpc, release, pins } = await recoveryFixture();
  const factory = new IDBFactory();
  const me = burnerFrom(key('browser holder'));
  chain.fund(unhex(me.evmAddress), 10n ** 18n);
  let kv = new IdbKv('a', factory);
  const open = (rpc: JsonRpc) => nb2.openSession({
    settings: DEFAULTS, me, trust: root.trust, journal: kv, rpc, aggregator, gas,
    published: { release, pins, bundle: root.bundle, publishedPin: hx(root.pin), pluginCommit: '', url: '' },
    backup: async () => undefined, refreshTrust: async () => root.trust,
  });
  let browser = await open(rpc);
  const deposit = await nb2.planDeposit(browser, 19n);
  await nb2.sendDeposit(browser, deposit.intent);
  const { token } = await nb2.mint(browser, deposit.intent);
  const eligible = await nb2.planReturn(browser, token, unhex(me.evmAddress), undefined, kv, caps);
  assert.ok(eligible.record.recovery);
  await nb2.burn(browser, eligible.returnId, kv, async (backup) => assert.ok(JSON.parse(backup).pending.burnRequest), undefined, caps);
  const rec = (await nb2.returnRecord(browser, hx(eligible.returnId)))!;
  const stored = `return/recovery/${hx(chain.domain)}/${rec.returnId}`;
  const read = async () => JSON.parse((await kv.get(stored))!);

  const evidence = evidenceOf(unhex(rec.burned!));
  const session = await RecoverySession.create(chain.gamma, evidence, new RecoveryAuthority(root.trust, async () => undefined), TEST_PARAMS, deployment);
  const verdict = await verifyReturn(chain.gamma, evidence, root.trust, TEST_PARAMS);
  const reader = new EvmReader(rpc);
  let last: { hash: Uint8Array; event: RecoveryEvent; end: number } | undefined;
  chain.coldCall = async (vault, to, data) => {
    if (eq(to, recovery)) {
      assert.ok(!last);
      const packet = await session.run(0, rec.recovery!.runCuts[0], root.trust);
      assert.deepEqual(data, packet.calldata);
      last = { hash: decodeSignedTx(unhex((await read()).pending.raw)).hash, event: packet.event, end: packet.end };
      return [{ address: recovery, topics: packet.event.topics, data: packet.event.data }];
    }
    if (eq(to, cfg.vault) && hx(data.subarray(0, 4)) === selector('redeemRecovered(bytes)')) {
      assert.ok(last);
      const proof = await recoveryRpcSource(reader, last.hash)(deployment.recovery, last.event);
      const packet = await session.gaps('redeemRecovered', root.trust, proof!, { seq: 1n }, []);
      assert.deepEqual(data, packet.calldata);
      const history = buildHistory([], verdict.eta, verdict.minSegment, verdict.minSegment, unhex(rec.startHead));
      vault.redeem(verdict.eta, verdict.minSegment, history.history, { ret: verdictAbi(verdict) });
      return [];
    }
    return undefined;
  };
  let sent = 0;
  let rejectSegmentLogs = false;
  const interrupted: JsonRpc = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      if (rejectSegmentLogs && isSegmentLookup(method, params)) {
        throw new RpcError(200, -32000, 'primary-private-marker', { secret: 'primary-data' });
      }
      // coldCall models mined changes; a finalized eth_call must not advance its cursor.
      if (method === 'eth_call' && typeof params[1] === 'object') {
        const signed = decodeSignedTx(unhex((await read()).pending.raw));
        assert.equal((params[0] as { data: string }).data, hx(signed.request.data));
        assert.equal((params[0] as { from: string }).from, hx(signed.from));
        assert.equal((params[1] as { requireCanonical: boolean }).requireCanonical, true);
        return '0x' as T;
      }
      const result = await rpc.call<T>(method, params);
      if (method === 'eth_sendRawTransaction' && ++sent === 1) throw new Error('browser interrupted after send');
      return result;
    },
  };
  browser = await open(interrupted);
  const redeem = () => nb2.redeem(browser, eligible.returnId, undefined, 0, 0, kv, caps);
  chain.importedTipEpoch = 0n;
  await assert.rejects(redeem, { reason: 'ImportLag', retryable: true });
  assert.equal(sent, 0);
  const pendingRaw = (await read()).pending.raw;
  assert.ok(pendingRaw);
  chain.importedTipEpoch = 1n;
  await assert.rejects(redeem, /browser interrupted after send/);
  assert.equal((await read()).pending.raw, pendingRaw);
  kv = new IdbKv('a', factory);
  browser = await open(interrupted);
  const checkpoint = await redeem();
  assert.equal(checkpoint.state, 'checkpoint');
  assert.equal(checkpoint.state === 'checkpoint' && checkpoint.stage, 'Complete');
  assert.equal(sent, 1);
  assert.equal((await read()).pending, undefined);
  // Force the real recovery step to ask all readers for the next certified segment.
  const evm = browser.bridge.evm;
  const state = evm.vaultState.bind(evm);
  const fetchBefore = globalThis.fetch;
  const errorBefore = console.error;
  const logged: unknown[][] = [];
  let failedArchiveCalls = 0;
  rejectSegmentLogs = true;
  evm.vaultState = async (vault) => ({ ...await state(vault), segment: 1n });
  globalThis.fetch = async (_input, init) => {
    const { id, method, params } = JSON.parse(String(init?.body));
    if (isSegmentLookup(method, params)) {
      failedArchiveCalls++;
      return Response.json({ jsonrpc: '2.0', id, error: { code: -32000, message: 'archive-private-marker', data: { secret: 'archive-data' } } });
    }
    return Response.json({ jsonrpc: '2.0', id, result: await rpc.call(method, params) });
  };
  installFetchTrace();
  console.error = (...args: unknown[]) => { logged.push(args); };
  const trace = begin();
  let status: ReturnType<typeof reportStepFailure> | undefined;
  try {
    await nb2.redeem(browser, eligible.returnId, undefined, 0, 0, kv, { ...caps, archives: ['/archive-rpc'] });
  } catch (error) {
    status = reportStepFailure(error);
  } finally {
    end(trace);
    evm.vaultState = state;
    globalThis.fetch = fetchBefore;
    console.error = errorBefore;
    rejectSegmentLogs = false;
  }
  assert.equal(failedArchiveCalls, 1);
  assert.equal(status?.ok, false);
  assert.match(status!.text, /No configured reader supplied certified segment history/);
  assert.deepEqual(trace.facts.at(-1), ['error', status!.text]);
  assert.deepEqual(logged, [[status!.text]]);
  assert.doesNotMatch(JSON.stringify({ status, trace, logged }), /private-marker|archive-data|primary-data/);
  assert.equal(sent, 1, 'failed archive lookups must leave the continuation unsigned');
  assert.equal((await redeem()).state, 'paid');
  assert.equal(sent, 2);
  assert.equal(chain.vault.events.filter((event) => event.name === 'Paid').length, 1);
  assert.ok((await nb2.returnRecord(browser, rec.returnId))?.paid?.receipt);
});
