/** Recovery graph and calibration fixtures from native-bridge-plugins a2ce55ffe4 wallet/recovery.test.ts. */
import { keccak_256 as HE } from '@noble/hashes/sha3.js';
import { recoveryGeneration, type JsonRpc } from '@unicitylabs/native-bridge-plugin/nb2';
import { hex, unhex } from '../src/hex.js';
import { type PayerPolicy } from '../src/recovery.js';
import { FakeChain, FakeAggregator, key, makeConfig, makeRoot } from './world.js';

const ascii = (s: string) => new TextEncoder().encode(s);
const hx = (b: Uint8Array) => `0x${hex(b)}`;
export const selector = (name: string) => hx(HE(ascii(name)).subarray(0, 4));
export const caps: PayerPolicy = { signedBytes: 524_288, calldataBytes: 524_288, gas: 24_000_000n, maxNonce: 10_000n,
  maxFeePerGas: 30n, maxPriorityFeePerGas: 2n, maxTransactionFee: 10n ** 9n, feeBudget: 10n ** 12n, archives: [] };

export async function recoveryFixture(ordinary = false) {
  const root = await makeRoot();
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
      ...(ordinary ? { ordinaryRanges: [{ maxEvidenceBytes: 100_000, maxOperations: 10, maxGaps: '64', execution: '1000000' }] } : {}),
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
  return { root, cfg, chain, deployment, recovery, aggregator, rpc, release, pins };
}
