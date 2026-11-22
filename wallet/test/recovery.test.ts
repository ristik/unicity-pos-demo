import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak_256 as HE } from '@noble/hashes/sha3.js';
import { IDBFactory } from 'fake-indexeddb';
import {
  EvmReader, RecoveryAuthority, RecoverySession, TEST_PARAMS, buildHistory, decodeSignedTx,
  evidenceOf, recoveryGeneration, recoveryRpcSource, verifyReturn, verdictAbi,
  type JsonRpc, type GasModel, type RecoveryEvent,
} from '@unicitylabs/native-bridge-plugin/nb2';
import { DEFAULTS } from '../src/config.js';
import { eqBytes as eq, hex, unhex } from '../src/hex.js';
import { IdbKv } from '../src/idb.js';
import { burnerFrom } from '../src/keys.js';
import * as nb2 from '../src/nb2.js';
import { type PayerPolicy } from '../src/recovery.js';
import { FakeChain, FakeAggregator, key, makeConfig, makeRoot } from './world.js';

const ascii = (s: string) => new TextEncoder().encode(s);
const hx = (b: Uint8Array) => `0x${hex(b)}`;

/** Recovery deployment calibration and graph fixtures adapted from the reference wallet's recovery test. */
const caps: PayerPolicy = { signedBytes: 524_288, calldataBytes: 524_288, gas: 24_000_000n, maxNonce: 10_000n,
  maxFeePerGas: 30n, maxPriorityFeePerGas: 2n, maxTransactionFee: 10n ** 9n, feeBudget: 10n ** 12n, archives: [] };
const gas: GasModel = { name: 'fixture without ordinary admission', depositGasLimit: () => 1_000_000n, redeemGasLimit: () => null };
const selector = (name: string) => hx(HE(ascii(name)).subarray(0, 4));

test('continuation resumes the exact signed bytes and reaches certified Paid', async () => {
  const root = await makeRoot(1);
  const code = ascii('simulated ordinary');
  const cfg = { ...makeConfig(root), verifierCodeHash: HE(code) };
  const chain = await FakeChain.create(root, cfg);
  const aggregator = new FakeAggregator(root);
  const recovery = Uint8Array.from(new Uint8Array(20).fill(7));
  const recoveryCode = ascii('simulated recovery');
  const deployment = { recovery, salt: key('salt'), pins: key('pins'), runtimeHash: HE(recoveryCode), vaultRuntimeHash: HE(chain.vaultCode) };
  const generation = recoveryGeneration(deployment.salt, chain.domain);
  const receiptHelper = new Uint8Array(20).fill(8);
  const lineageHelper = new Uint8Array(20).fill(9);
  const registry = unhex('0xff00000000000000000000000000000000000002');
  const word = (a: Uint8Array) => hx(Uint8Array.from([...new Uint8Array(12), ...a]));
  const views = new Map([
    [selector('RECOVERY()'), word(recovery)],
    [selector('RECOVERY_RUNTIME()'), hx(deployment.runtimeHash)],
    [selector('RECOVERY_PINS()'), hx(deployment.pins)],
    [selector('RECOVERY_GENERATION()'), hx(generation)],
  ]);
  const recoveryViews = new Map([[selector('RECEIPTS()'), word(receiptHelper)], [selector('LINEAGE()'), word(lineageHelper)]]);
  for (const [getter, address] of [['RECEIPTS_HASH()', receiptHelper], ['LINEAGE_HASH()', lineageHelper], ['REGISTRY_HASH()', registry]] as const) {
    const runtime = ascii(getter);
    chain.code.set(hx(address).slice(2), runtime);
    recoveryViews.set(selector(getter), hx(HE(runtime)));
  }
  const range = (entry: string, operations: number, gaps: number) => ({
    minReceiptBytes: entry === 'run' ? 0 : 1,
    max: { entry, operations, gaps, calldataBytes: 393216, pages: 32, receiptBytes: 65536, openingBytes: 393216 },
    execution: '1000000',
  });
  chain.code.set(hx(cfg.verifier).slice(2), code);
  chain.code.set(hx(recovery).slice(2), recoveryCode);
  const rpcOn = (view: FakeChain): JsonRpc => ({ call: async <T>(method: string, params: unknown[]): Promise<T> => {
    if (method === 'eth_call') {
      const { to, data } = params[0] as { to: string; data: string };
      const result = to === hx(cfg.vault) ? views.get(data) : to === hx(recovery) ? recoveryViews.get(data) : undefined;
      if (result) return result as T;
    }
    return view.call<T>(method, params);
  } });
  const rpc = rpcOn(chain);

  const release = {
    pins: {},
    recovery: { salt: hx(deployment.salt), address: hx(recovery), runtimeHash: hx(deployment.runtimeHash), pins: hx(deployment.pins),
      ranges: [
        ...Array.from({ length: 16 }, (_, i) => range('run', i + 1, 0)),
        ...Array.from({ length: 65 }, (_, i) => range('advanceGaps', 0, i + 1)),
        ...Array.from({ length: 65 }, (_, i) => range('redeemRecovered', 0, i)),
      ],
      backlog: { duringProgress: '0', peakSeals: '0', elapsedMs: '1000', receiptP99Ms: '1000',
        advancePeakSeals: '0', finalInclusionMs: '25', finalPeakSeals: '0', qualifiedForMs: '100000' },
    },
  };
  const pins = { gamma: chain.gamma, build: 'test' as const, vaultRuntimeCodeHash: deployment.vaultRuntimeHash,
    maxEncodedTxBytes: 524288n, userGasLimit: 24000000n, gasReserve: 500000n, returnReserveSegments: 64n, deploymentBlock: 1n, stateReadOnly: false };
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
  await nb2.burn(browser, eligible.returnId, undefined, kv, caps);
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
  const interrupted: JsonRpc = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const result = await rpc.call<T>(method, params);
      if (method === 'eth_sendRawTransaction' && ++sent === 1) throw new Error('browser interrupted after send');
      return result;
    },
  };
  browser = await open(interrupted);
  const redeem = () => nb2.redeem(browser, eligible.returnId, undefined, 0, 0, kv, caps);
  await assert.rejects(redeem, /browser interrupted after send/);
  assert.ok((await read()).pending.raw);
  kv = new IdbKv('a', factory);
  browser = await open(interrupted);
  const checkpoint = await redeem();
  assert.equal(checkpoint.state, 'checkpoint');
  assert.equal(checkpoint.state === 'checkpoint' && checkpoint.stage, 'Complete');
  assert.equal(sent, 1);
  assert.equal(await (await read()).pending, undefined);
  assert.equal((await redeem()).state, 'paid');
  assert.equal(sent, 2);
  assert.equal(chain.vault.events.filter((event) => event.name === 'Paid').length, 1);
  assert.ok((await nb2.returnRecord(browser, rec.returnId))?.paid?.receipt);
});
