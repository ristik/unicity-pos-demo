/**
 * The visualizer's committee arithmetic against the contracts' own vectors: test/fixtures/p85/*-vectors.json are contracts 7b510f6b
 * test/p85/fixtures/{continuity,selection,quant}-vectors.json (jq -c, numbers unchanged), the bft-core Go reference outputs the Solidity
 * port is tested against. Plus the quorum thresholds and the ABI decoder on return data captured from the dev network.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { decode, encodeArgs, keccakHex, parseSignature, selectorOf, signingBinding } from '../src/pos/abi.js';
import { FN } from '../src/pos/contracts.js';
import { check, evmThreshold, fraction, InvalidCommittee, quantize, quorumView, rootQuorum, select, type Member } from '../src/pos/rules.js';

type Raw = { id: number | string; binding: number | string; weight: number | string };

/** JSON with every number kept exact (as a bigint) where the runtime passes the source text to the reviver (Node 22+). */
function load<T>(name: string): T {
  const text = readFileSync(new URL(`./fixtures/p85/${name}`, import.meta.url), 'utf8');
  return JSON.parse(text, function (this: unknown, _k: string, v: unknown, ctx?: { source?: string }) {
    return typeof v === 'number' && ctx?.source && /^\d+$/.test(ctx.source) ? BigInt(ctx.source) : v;
  } as never) as T;
}
const big = (v: unknown): bigint => BigInt(v as bigint | number | string);
const members = (xs: Raw[]): Member[] => xs.map((m) => ({ id: big(m.id), binding: String(m.binding), weight: big(m.weight) }));

test('root quorum floor(2W/3)+1 and EVM threshold floor(W/2)+1', () => {
  assert.deepEqual([1n, 3n, 4n, 5n, 6n, 9n].map(rootQuorum), [1n, 3n, 3n, 4n, 5n, 7n]);
  assert.deepEqual([1n, 4n, 5n, 9n].map(evmThreshold), [1n, 3n, 3n, 5n]);
  // ARCH §3: weights (6,1,1,1) give quorum 7 and EVM threshold 5
  const v = quorumView([6n, 1n, 1n, 1n].map((w, i) => ({ id: BigInt(i + 1), weight: w, online: true })));
  assert.equal(v.rootQuorum, 7n);
  assert.equal(v.evmThreshold, 5n);
});

test('what-if: four unit members tolerate one offline, not two; the weight-6 member alone stops the root quorum', () => {
  const four = (off: number[]) => quorumView([1, 2, 3, 4].map((id) => ({ id: BigInt(id), weight: 1n, online: !off.includes(id) })));
  assert.equal(four([]).rootHolds, true);
  assert.equal(four([4]).rootHolds, true);
  assert.equal(four([3, 4]).rootHolds, false);
  assert.equal(four([3, 4]).evmHolds, false);
  assert.equal(four([4]).rootSlack, 1n);
  const heavy = quorumView([6n, 1n, 1n, 1n].map((w, i) => ({ id: BigInt(i + 1), weight: w, online: i !== 0 })));
  assert.equal(heavy.online, 3n);
  assert.equal(heavy.rootHolds, false);
  // five unit members: quorum 4, so still only one may be missing (the laptop joiner case)
  assert.equal(quorumView([1, 2, 3, 4, 5].map((id) => ({ id: BigInt(id), weight: 1n, online: id < 5 }))).rootHolds, true);
  assert.equal(quorumView([1, 2, 3, 4, 5].map((id) => ({ id: BigInt(id), weight: 1n, online: id < 4 }))).rootHolds, false);
});

test('Continuity: every vector of continuity-vectors.json', () => {
  const v = load<{ cases: { name: string; old: Raw[]; new: Raw[]; maxM: number; distNum: number; distDen: number; invalid: string; result: Record<string, unknown> }[] }>('continuity-vectors.json');
  assert.ok(v.cases.length > 400);
  for (const c of v.cases) {
    const p = { maxM: big(c.maxM), distNum: big(c.distNum), distDen: big(c.distDen) };
    if (c.invalid) {
      assert.throws(() => check(members(c.old), members(c.new), p), (e: unknown) => e instanceof InvalidCommittee && e.successor === (c.invalid === 'successor'), c.name);
      continue;
    }
    const { failed, measured } = check(members(c.old), members(c.new), p);
    const r = c.result;
    assert.equal(failed, Number(r.failed), `${c.name}: failed`);
    for (const k of ['replaced', 'removed', 'added', 'm', 'unchangedOld', 'unchangedNew', 'totalOld', 'totalNew', 'distanceNumerator'] as const) {
      assert.equal(measured[k], big(r[k]), `${c.name}: ${k}`);
    }
  }
});

test('Quantize: every vector of quant-vectors.json', () => {
  const v = load<{ cases: { name: string; b: number; x: string[]; q?: string[]; error?: boolean }[] }>('quant-vectors.json');
  for (const c of v.cases) {
    const x = c.x.map(big);
    if (c.error) assert.throws(() => quantize(x, big(c.b)), c.name);
    else assert.deepEqual(quantize(x, big(c.b)), c.q!.map(big), c.name);
  }
});

test('Selection: every vector of selection-vectors.json', () => {
  const v = load<{ cases: { name: string; old: Raw[]; eligible: Raw[]; config: Record<string, number>; reason: number; chosen: number[]; chosenWeights: number[] }[] }>('selection-vectors.json');
  assert.ok(v.cases.length > 200);
  for (const c of v.cases) {
    const cfg = { nMin: Number(c.config.nMin), nTarget: Number(c.config.nTarget), nMax: Number(c.config.nMax), maxM: big(c.config.maxM), distNum: big(c.config.distNum), distDen: big(c.config.distDen) };
    const r = select(members(c.old), members(c.eligible), cfg);
    assert.equal(r.reason, Number(c.reason), `${c.name}: reason`);
    assert.deepEqual(r.chosen.map((m) => m.id), (c.chosen ?? []).map(big), `${c.name}: chosen`);
    assert.deepEqual(r.chosen.map((m) => m.weight), (c.chosenWeights ?? []).map(big), `${c.name}: weights`);
  }
});

test('the dev-network case: 4 unit incumbents, one laptop joiner of weight 1 is admitted (D = 2/5 ≤ 1/2), two at once are not', () => {
  const o = [1, 2, 3, 4].map((id) => ({ id: BigInt(id), binding: `b${id}`, weight: 1n }));
  const cfg = { nMin: 4, nTarget: 6, nMax: 6, maxM: 4n, distNum: 1n, distDen: 2n };
  const one = select(o, [...o, { id: 5n, binding: 'b5', weight: 1n }], cfg);
  assert.equal(one.reason, 0);
  assert.deepEqual(one.chosen.map((m) => m.id), [1n, 2n, 3n, 4n, 5n]);
  const m = check(o, one.chosen, cfg).measured;
  assert.equal(fraction(m.distanceNumerator, m.totalOld * m.totalNew), '2/5 ≈ 0.400');
  // two joiners: turnover 3·2 ≥ 4 fails, so the first is kept and the second skipped
  const two = select(o, [...o, { id: 5n, binding: 'b5', weight: 1n }, { id: 6n, binding: 'b6', weight: 1n }], cfg);
  assert.deepEqual(two.chosen.map((x) => x.id), [1n, 2n, 3n, 4n, 5n]);
});

test('ABI: selectors, argument encoding and decoding of captured dev-network return data', () => {
  assert.equal(parseSignature('delegation(uint64 id, uint64 gen)').canonical, 'delegation(uint64,uint64)');
  assert.equal(selectorOf('transfer(address,uint256)'), 'a9059cbb');
  assert.equal(encodeArgs(['uint64', 'uint64'], [1n, 2n]), `${'0'.repeat(63)}1${'0'.repeat(63)}2`);
  // limits() on tn-pos-dev-20261112
  const limits = decode(FN.limits.out, `0x${[16, 1, 4, 32].map((n) => n.toString(16).padStart(64, '0')).join('')}`);
  assert.deepEqual(limits, { vMax: 16n, lMax: 1n, rMax: 4n, maxBatch: 32n });
  // committed(assignment) → one dynamic array of static tuples
  const w = (n: bigint | number | string): string => (typeof n === 'string' ? n.replace(/^0x/, '').padStart(64, '0') : BigInt(n).toString(16).padStart(64, '0'));
  const b1 = '934f4a258bd3a34ff8f919cce6de8b9668824aef2121bef33873f9e2ed248db5';
  const committed = decode(FN.committed.out, `0x${w(32)}${w(2)}${w(1)}${w(b1)}${w(1)}${w(2)}${w(b1)}${w(3)}`);
  assert.deepEqual(committed, [{ id: 1n, binding: `0x${b1}`, weight: 1n }, { id: 2n, binding: `0x${b1}`, weight: 3n }]);
  // recordAt → one dynamic tuple with a bytes member
  const rec = decode(FN.recordAt.out, `0x${w(32)}${w(7)}${w(b1)}${w(0)}${w(2)}${w(100)}${w(200)}${w(7 * 32)}${w(3)}${'abcdef'.padEnd(64, '0')}`) as { r: Record<string, unknown> };
  assert.equal(rec.r.kind, 2n);
  assert.equal(rec.r.data, '0xabcdef');
  // the signing binding of identity 1 on the dev network (EligibilityReader.committed's value)
  assert.equal(keccakHex('0x035360122dd6f45ec7aeff1026fcde58447ba654d48e60ac639af66c8068670473'), '0x05e62190fa1788665703ecb925def8eeadabda934dab817c4b3941b76f60b0cd');
  assert.equal(signingBinding('0x05e62190fa1788665703ecb925def8eeadabda934dab817c4b3941b76f60b0cd', '0x29beb23f6df73d852a63cceb762f0b94f9198c5297e079de98146b50617dd1f5'), `0x${b1}`);
});
