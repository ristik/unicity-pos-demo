/**
 * The validator-registry read model (src/pos/vr.ts) against a fixture chain: a fake eth_call endpoint whose answers are ABI-encoded from a
 * scenario with a small encoder written here (the page only decodes). Two scenarios: the PoA generation (PoaElection active, a queued
 * Admit by the Foundation multisig, an applied identity, a partition change in the history) and a PoS generation (a module that names custody
 * as its liability holder; VR ids equal custody StakingIDs, and a mismatch is reported). The PoS panels are tested with this fixture, not
 * against a live PoS generation.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { keccak_256 } from '@noble/hashes/sha3.js';

import { parseParam, parseTuple, parseSignature, selectorOf, type AbiType } from '../src/pos/abi.js';
import { Chain, type Addresses } from '../src/pos/chain.js';
import { CHANGE_PAYLOAD, FN, POA_TAG, POS_TAG, type FnName } from '../src/pos/contracts.js';
import { boundaryOf, describeChange, modeOf, partitionOf, poaAction, readVr, readVrPointers, type VrModel } from '../src/pos/vr.js';
import { hex, unhex } from '../src/hex.js';

// ---- a small ABI encoder (the page has only a decoder) -------------------------------------------------------------------------------------------
type V = bigint | number | boolean | string | V[] | { [k: string]: V };
const isDyn = (t: AbiType): boolean => t.kind === 'bytes' || t.kind === 'string' || (t.kind === 'array' && (t.length === null || isDyn(t.of))) || (t.kind === 'tuple' && t.fields.some((f) => isDyn(f.type)));
const w = (n: bigint): Uint8Array => unhex(n.toString(16).padStart(64, '0'));
const cat = (...p: Uint8Array[]): Uint8Array => Uint8Array.from(p.flatMap((x) => [...x]));
const pad32 = (b: Uint8Array): Uint8Array => cat(b, new Uint8Array((32 - (b.length % 32)) % 32));

function enc(t: AbiType, v: V): Uint8Array {
  switch (t.kind) {
    case 'uint': case 'int': return w(BigInt(v as bigint | number));
    case 'bool': return w(v ? 1n : 0n);
    case 'address': return cat(new Uint8Array(12), unhex(v as string));
    case 'fixed': return pad32(unhex(v as string)).slice(0, 32);
    case 'bytes': { const b = unhex(v as string); return cat(w(BigInt(b.length)), pad32(b)); }
    case 'string': { const b = new TextEncoder().encode(v as string); return cat(w(BigInt(b.length)), pad32(b)); }
    case 'array': {
      const xs = v as V[];
      const body = encSeq(xs.map(() => t.of), xs);
      return t.length === null ? cat(w(BigInt(xs.length)), body) : body;
    }
    case 'tuple': return encSeq(t.fields.map((f) => f.type), t.fields.map((f) => (v as { [k: string]: V })[f.name]));
  }
}
function encSeq(ts: AbiType[], vs: V[]): Uint8Array {
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  const size = (t: AbiType): number => (isDyn(t) ? 32 : t.kind === 'tuple' ? t.fields.reduce((a, f) => a + size(f.type), 0) : t.kind === 'array' ? (t.length ?? 0) * size(t.of) : 32);
  const headLen = ts.reduce((a, t) => a + size(t), 0);
  let tailLen = 0;
  ts.forEach((t, i) => {
    if (isDyn(t)) {
      heads.push(w(BigInt(headLen + tailLen)));
      const e = enc(t, vs[i]);
      tails.push(e);
      tailLen += e.length;
    } else heads.push(enc(t, vs[i]));
  });
  return cat(...heads, ...tails);
}
/** abi.encode of return values for an output list ("uint64 id,bytes32 h"; one unnamed output is passed bare). */
function encodeOut(outputs: string, value: V): string {
  const t = parseTuple(outputs) as Extract<AbiType, { kind: 'tuple' }>;
  const single = t.fields.length === 1 && t.fields[0].name === '0';
  return `0x${hex(encSeq(t.fields.map((f) => f.type), single ? [value] : t.fields.map((f) => (value as { [k: string]: V })[f.name])))}`;
}

// ---- the fixture chain -------------------------------------------------------------------------------------------------------------------------------
const ADDR = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const H = (n: number | string): string => `0x${(typeof n === 'number' ? n.toString(16) : n).padStart(64, '0')}`;
const VR = '0xff00000000000000000000000000000000000003';
const REGISTRY = '0xff00000000000000000000000000000000000002';
const MULTISIG = ADDR(0x5151);
const PoA = ADDR(0xaaa1);
const ADAPTER = ADDR(0xaaa2);
const CUSTODY = ADDR(0xc057);
const ELECTION = ADDR(0xe1ec);

const member = (id: number, rk = H(0x100 + id)): V => ({ id, generation: 1, weight: 1, rawWeight: 1, rootNodeWord: H(0x200 + id), rootKeyHash: rk, evmNodeWord: H(0x300 + id), evmKeyHash: H(0x400 + id), payee: ADDR(0x500 + id), exposureDigest: H(0) });
const binding = (id: number, set = true): V => ({ rootNodeWord: H(0), rootKeyHash: set ? H(0x100 + id) : H(0), evmNodeWord: H(0), evmKeyHash: H(0), payee: set ? ADDR(0x500 + id) : ADDR(0), rootNodeID: set ? `12D3KooWroot${id}` : '', rootKey: set ? `0x02${'ab'.repeat(32)}` : '0x', evmNodeID: set ? `12D3KooWevm${id}` : '', evmKey: set ? `0x03${'cd'.repeat(32)}` : '0x' });
const identity = (id: number): V => ({ owner: ADDR(0x900 + id), generation: 1, currentRef: H(id), stagedRef: H(0), bindingNonce: 0, registrationNonce: 1, current: binding(id), staged: binding(0, false), endpoints: '0x' });
const abiBytes = (...ws: bigint[]): string => `0x${hex(cat(...ws.map(w)))}`;
const moduleAction = (action: number, id: number): string => `0x${hex(encSeq([{ kind: 'address' }, { kind: 'bytes' }] as AbiType[], [PoA, abiBytes(BigInt(action), BigInt(id))]))}`;
const partitionUpdate = (partition: number): string => `0x${hex(encSeq(parseTuple(CHANGE_PAYLOAD[8]).kind === 'tuple' ? (parseTuple(CHANGE_PAYLOAD[8]) as Extract<AbiType, { kind: 'tuple' }>).fields.map((f) => f.type) : [], [partition, '0x80', H(7), '0x1234']))}`;

interface Scenario {
  mode: 'poa' | 'pos';
  /** custody's rootKeyHash of id 2, to make a mismatch */
  custodyRk2?: string;
  /** a module tag other than the mode's */
  tag?: string;
}

function fixture(sc: Scenario) {
  const calls: string[] = [];
  const poa = sc.mode === 'poa';
  const changes: Record<number, V> = {
    1: { kind: 8, state: 4, rejectReason: 0, notBeforeProgress: 10, notBeforeTime: 10, activeRootEpoch: 2, scheduledAt: 20, payloadHash: H(0), boundTo: H(0), payload: partitionUpdate(7) },
    2: { kind: 2, state: 1, rejectReason: 0, notBeforeProgress: 1500, notBeforeTime: 2_000_000_900, activeRootEpoch: 0, scheduledAt: 0, payloadHash: H(0), boundTo: H(0), payload: moduleAction(1, 4) },
    3: { kind: 5, state: 3, rejectReason: 0, notBeforeProgress: 10, notBeforeTime: 10, activeRootEpoch: 0, scheduledAt: 1200, payloadHash: H(0), boundTo: H(0xb0), payload: `0x${hex(encSeq([{ kind: 'uint', bits: 64 }, { kind: 'uint', bits: 64 }, { kind: 'address' }] as AbiType[], [1000, 8, ADDR(0xfe)]))}` },
  };
  const state: Record<string, (args: bigint[]) => V> = {
    progress: () => 1300n, ucTime: () => 2_000_000_000n, recordCount: () => 12n,
    vrRecordCursor: () => 12n, vrHealth: () => 0, vrOpenOutput: () => H(0xb0), vrLastAcked: () => H(0xa0),
    vrActiveModule: () => ({
      module: poa ? PoA : ADAPTER, codeHash: H(0xc0de),
      meta: { moduleTag: sc.tag ?? (poa ? POA_TAG : POS_TAG), capabilities: 0, maxElectionInterval: 1000, gasBounds: [1, 2, 3, 4, 5, 6, 7, 8], liabilityHolder: poa ? ADDR(0) : CUSTODY, liabilityHolderCodeHash: H(0) },
      health: 0, workPending: true, workSince: 1250, stallDeadline: 40_000,
    }),
    vrConfig: () => ({
      network: H(3), governor: MULTISIG, nMin: 1, nTarget: 4, nMax: 7, vMax: 16, lMax: 8, rMax: 8, maxBatch: 32,
      feesPrevious: { baseFeeFloor: 500, changeDenominator: 8, feeCollector: ADDR(0xfe) }, feesCurrent: { baseFeeFloor: 1000, changeDenominator: 8, feeCollector: ADDR(0xfe) }, feesEffectiveBlock: 99,
      delayRounds: 2000, delaySeconds: 3600, knownRootEpoch: 2, epochStartProgress: 1200, maxGas: 60_000_000, systemGas: 1_000_000, continuityMaxM: 2, continuityDistNum: 1, continuityDistDen: 2,
    }),
    vrCommittee: () => [member(1), member(2, H(0x102)), member(3)],
    vrOutput: ([id]) => ({
      state: id === BigInt(0xb0) ? 1 : 5, attempt: 3, reservedProgress: 1250, expiresAtProgress: 1250 + 16384, predecessor: H(0xa0), sourceModule: poa ? PoA : ADAPTER, native: false, moduleTag: H(1),
      membersDigest: H(0), kDigest: H(0), changesDigest: H(0), snapshotDigest: H(0), policyDigest: H(0), outputCommit: H(0), invalidReason: 0, invalidAtProgress: 0, members: id === BigInt(0xb0) ? [] : [member(1), member(2), member(3)], changes: id === BigInt(0xb0) ? [3] : [],
    }),
    vrIdentity: ([id]) => (id >= 1n && id <= 4n ? identity(Number(id)) : { owner: ADDR(0), generation: 0, currentRef: H(0), stagedRef: H(0), bindingNonce: 0, registrationNonce: 0, current: binding(0, false), staged: binding(0, false), endpoints: '0x' }),
    vrPendingChanges: () => [2n, 3n],
    vrChange: ([id]) => changes[Number(id)] ?? { kind: 0, state: 0, rejectReason: 0, notBeforeProgress: 0, notBeforeTime: 0, activeRootEpoch: 0, scheduledAt: 0, payloadHash: H(0), boundTo: H(0), payload: '0x' },
    vrActivationCount: () => 0, vrActivationAt: () => ({ ruleId: H(0), releaseDigest: H(0), rootEpoch: 0, notBeforeUcTime: 0, state: 0, changeId: 0 }),
    vrHolderCount: () => 1, vrHolderAt: () => ({ holder: CUSTODY, holderCodeHash: H(1), module: ADAPTER, registeredEpoch: 1 }),
    poaStatus: ([id]) => ({ state: id <= 3n ? 4 : 1, sinceProgress: id <= 3n ? 0 : 1100 }),
    poaMembers: () => [1n, 2n, 3n], poaQueue: () => [4n], poaParkPeriod: () => 32768n,
    msSigners: () => [ADDR(0x11), ADDR(0x12), ADDR(0x13), ADDR(0x14), ADDR(0x15)], msNextSigners: () => [ADDR(0), ADDR(0), ADDR(0), ADDR(0), ADDR(0)], msNonce: () => 7, msSignersPending: () => false,
    msNotBeforeProgress: () => 0, msNotBeforeTime: () => 0,
    custodyElection: () => ELECTION,
    positions: ([id]) => ({ owner: ADDR(0x900 + Number(id)), withdrawal: ADDR(0), rootKeyHash: id === 2n && sc.custodyRk2 ? sc.custodyRk2 : H(0x100 + Number(id)), stagedRootKeyHash: H(0), generation: 1, roleNonce: 0, openLots: 1, lotCount: 1, retirementRequested: false }),
  };
  const bySelector = new Map<string, { name: FnName; fn: (typeof FN)[FnName] }>();
  for (const [name, fn] of Object.entries(FN) as [FnName, (typeof FN)[FnName]][]) bySelector.set(`${(fn.contract as string) === 'registry' ? REGISTRY : ''}${selectorOf(parseSignature(fn.sig).canonical)}`, { name, fn });
  const evm = {
    rpc: async <T>(method: string, params: unknown[] = []): Promise<T> => {
      if (method === 'eth_blockNumber') return '0x2a' as T;
      assert.equal(method, 'eth_call');
      const { to, data } = params[0] as { to: string; data: string };
      const sel = data.slice(2, 10);
      const hit = [...bySelector.entries()].find(([k, v]) => k.endsWith(sel) && ((v.fn.contract as string) === 'registry' ? to.toLowerCase() === REGISTRY : (v.fn.contract as string) !== 'registry'))?.[1];
      assert.ok(hit, `no function for selector ${sel}`);
      const handler = state[hit.name];
      if (!handler) throw new Error(`fixture: nothing for ${hit.name}`);
      calls.push(`${hit.name}@${to.toLowerCase()}`);
      const args: bigint[] = [];
      const inputs = parseSignature(hit.fn.sig).inputs;
      inputs.forEach((_, i) => args.push(BigInt(`0x${data.slice(10 + 64 * i, 74 + 64 * i)}`)));
      return encodeOut(hit.fn.out, handler(args)) as T;
    },
  };
  const addresses: Addresses = { registry: REGISTRY, custody: '', election: '', rewardPool: '', reader: '', evidence: '', governance: '', vr: VR, poa: '', multisig: '' };
  const chain = new Chain('http://fixture', addresses, 0, evm as never);
  const logs = () => ({ vr: [], module: [], identities: [], governance: [] });
  return { chain, calls, logs };
}

test('PoA_TAG is keccak256("unicity.vr.poa.v1")', () => {
  assert.equal(`0x${hex(keccak_256(new TextEncoder().encode('unicity.vr.poa.v1')))}`, POA_TAG);
});

test('the PoA generation: module, identities and their PoA states, the queue, the multisig, the config', async () => {
  const { chain, logs } = fixture({ mode: 'poa' });
  const m = (await readVr(chain, logs()))!;
  assert.equal(m.mode, 'poa');
  assert.equal(m.module.address, PoA);
  assert.equal(chain.addresses.poa, PoA);
  assert.deepEqual(m.committee.map((c) => c.id), [1n, 2n, 3n]);
  assert.deepEqual(m.identities.map((i) => [i.id, i.poaState, i.inCommittee]), [[1n, 4n, true], [2n, 4n, true], [3n, 4n, true], [4n, 1n, false]]);
  assert.equal(m.identities[3].current.rootNodeID, '12D3KooWroot4');
  assert.deepEqual(m.poa?.members, [1n, 2n, 3n]);
  assert.deepEqual(m.poa?.queue, [4n]);
  assert.equal(m.multisig?.signers.length, 5);
  assert.equal(m.multisig?.nonce, 7n);
  assert.equal(m.cfg.nTarget, 4n);
  assert.equal(m.cfg.feesCurrent.baseFeeFloor, 1000n);
  assert.equal(m.custody, undefined);
  // the open output (Reserved) carries bound change #3; its expiry is read for the Bound change
  assert.equal(m.output?.id, H(0xb0));
  assert.equal(m.output?.state, 1n);
  assert.deepEqual(m.pending.map((c) => [c.id, c.state]), [[2n, 1], [3n, 3]]);
  assert.equal(m.pending[1].expiresAtProgress, BigInt(1250 + 16384));
  assert.deepEqual(m.history.map((c) => c.id), [1n, 2n, 3n]);
});

test('changes are described as ubft governance list does', async () => {
  const { chain, logs } = fixture({ mode: 'poa' });
  const m = (await readVr(chain, logs()))!;
  assert.match(describeChange(m.pending[0].kind, m.pending[0].payload), /^ModuleAction Admit identity 4 on module 0x000000000000000000000000000000000000aaa1$/);
  assert.match(describeChange(m.pending[1].kind, m.pending[1].payload), /^FeeParams\(baseFeeFloor=1000, changeDenominator=8, feeCollector=0x00000000000000000000000000000000000000fe\)$/);
  assert.deepEqual(poaAction(m.pending[0].payload), { module: PoA, action: 1, id: 4n });
  assert.equal(partitionOf(m.history[0]), 7n);
  assert.equal(partitionOf(m.history[1]), null);
  assert.match(describeChange(8, '0x12'), /not readable/);
});

test('the next boundary: an open output, or the gate and pending work', async () => {
  const { chain, logs } = fixture({ mode: 'poa' });
  const m = (await readVr(chain, logs()))!;
  const open = boundaryOf(m);
  assert.equal(open.open, true);
  assert.equal(open.expires, BigInt(1250 + 16384));
  assert.match(open.text, /an output is open/);
  const idle: Pick<VrModel, 'progress' | 'cfg' | 'module' | 'openOutput' | 'output'> = { ...m, openOutput: H(0), output: null, progress: 1250n };
  const b = boundaryOf(idle);
  assert.equal(b.dueProgress, 1300n); // epoch start 1200 + MIN_EPOCH_GAP 100
  assert.equal(b.roundsToGo, 50n);
  assert.match(b.text, /next election is due at progress 1300, in 50 rounds/);
  assert.match(boundaryOf({ ...idle, module: { ...m.module, workPending: false } }).text, /no election is due/);
});

test('the pointer read is the cheap one and gives the same key as the full read', async () => {
  const { chain, logs, calls } = fixture({ mode: 'poa' });
  const m = (await readVr(chain, logs()))!;
  const before = calls.length;
  const p = await readVrPointers(chain, []);
  assert.equal(p.key, m.key);
  assert.ok(calls.length - before <= 7, `${calls.length - before} calls`);
});

test('the PoS generation: custody is reached through VR\'s liability holder, and VR ids equal StakingIDs', async () => {
  const { chain, logs } = fixture({ mode: 'pos' });
  const m = (await readVr(chain, logs()))!;
  assert.equal(modeOf(m.module), 'pos');
  assert.equal(m.mode, 'pos');
  assert.equal(chain.addresses.custody, CUSTODY);
  assert.equal(chain.addresses.election, ELECTION);
  assert.equal(m.custody?.heldBy, CUSTODY);
  assert.equal(m.custody?.allEqual, true);
  assert.deepEqual(m.custody?.rows.map((r) => [r.id, r.equal]), [[1n, true], [2n, true], [3n, true]]);
  assert.equal(m.poa, undefined);
  assert.equal(m.identities[0].poaState, undefined);
});

test('a custody position that disagrees with VR is reported', async () => {
  const { chain, logs } = fixture({ mode: 'pos', custodyRk2: H(0xdead) });
  const m = (await readVr(chain, logs()))!;
  assert.equal(m.custody?.allEqual, false);
  assert.deepEqual(m.custody?.rows.map((r) => r.equal), [true, false, true]);
});

test('a module with a liability holder but another tag is not labelled PoS, and its holder is not queried as custody', async () => {
  const { chain, logs, calls } = fixture({ mode: 'pos', tag: H(0x9051) });
  const m = (await readVr(chain, logs()))!;
  assert.equal(m.mode, 'other');
  assert.equal(m.custody, undefined);
  assert.ok(!calls.some((c) => c.startsWith('custodyElection')));
});

test('POS_TAG is keccak256("unicity.vr.pos-p85.v1")', () => {
  assert.equal(`0x${hex(keccak_256(new TextEncoder().encode('unicity.vr.pos-p85.v1')))}`, POS_TAG);
});

test('a network without VR reads as null (the P85-only page)', async () => {
  const addresses: Addresses = { registry: REGISTRY, custody: '', election: '', rewardPool: '', reader: '', evidence: '', governance: '', vr: VR, poa: '', multisig: '' };
  const chain = new Chain('http://x', addresses, 0, { rpc: async (m: string) => (m === 'eth_blockNumber' ? '0x1' : '0x') } as never);
  assert.equal(await readVr(chain, { vr: [], module: [], identities: [], governance: [] }), null);
  assert.ok(parseParam('uint64 x').type.kind === 'uint');
});
