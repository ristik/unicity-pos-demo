/**
 * The committee arithmetic the visualizer evaluates client-side, ported from the contracts at 7b510f6b so a hypothetical committee is judged
 * by the same rules the election applies:
 *  - weighted quorum: root floor(2W/3)+1 (bft-go-base types/root_trust_base_v2.go), EVM attestation floor(W/2)+1 (ARCH §3);
 *  - Quantize (src/p85/Quantize.sol): the committed weight q from the raw bonded weights x under the cap B = 65,536;
 *  - Continuity (src/p85/Continuity.sol): membership budget M, turnover < 1/3, weight distance D, unchanged-binding overlap > 2/3;
 *  - Selection (src/p85/Selection.sol): the ranked bounded greedy election over a snapshot (full re-measurement per trial, which is what
 *    the contract's incremental path computes).
 * All arithmetic is exact bigint arithmetic. test/rules.test.ts replays the contracts' own vector files.
 */

// ---- quorum -----------------------------------------------------------------------------------------------------------------------------------
export const rootQuorum = (w: bigint): bigint => (2n * w) / 3n + 1n;
export const evmThreshold = (w: bigint): bigint => w / 2n + 1n;

export interface WhatIfMember {
  id: bigint;
  weight: bigint;
  online: boolean;
}

export interface QuorumView {
  total: bigint;
  online: bigint;
  rootQuorum: bigint;
  evmThreshold: bigint;
  rootHolds: boolean;
  evmHolds: boolean;
  /** the largest weight that may go offline with the root quorum still reachable */
  rootSlack: bigint;
  evmSlack: bigint;
}

export function quorumView(members: WhatIfMember[]): QuorumView {
  const total = members.reduce((a, m) => a + m.weight, 0n);
  const online = members.reduce((a, m) => a + (m.online ? m.weight : 0n), 0n);
  const rq = rootQuorum(total);
  const et = evmThreshold(total);
  return { total, online, rootQuorum: rq, evmThreshold: et, rootHolds: online >= rq, evmHolds: online >= et, rootSlack: total - rq, evmSlack: total - et };
}

// ---- quantize -----------------------------------------------------------------------------------------------------------------------------------
export const WEIGHT_CAP_B = 65_536n;
const U64_MAX = (1n << 64n) - 1n;

export function quantize(x: bigint[], b = WEIGHT_CAP_B): bigint[] {
  const n = BigInt(x.length);
  if (n === 0n) throw new Error('EmptyCommittee');
  if (n >= b) throw new Error('CommitteeAboveCap');
  let total = 0n;
  for (const v of x) {
    if (v === 0n) throw new Error('ZeroWeight');
    total += v;
    if (total > U64_MAX) throw new Error('WeightOverflow');
  }
  if (total <= b) return [...x];
  const s = (total + (b - n) - 1n) / (b - n);
  return x.map((v) => (v / s === 0n ? 1n : v / s));
}

// ---- continuity ---------------------------------------------------------------------------------------------------------------------------------
export interface Member {
  id: bigint;
  /** the signing binding (keccak of SIGNING_DOMAIN, rootKeyHash, evmKeyHash); equal exactly when the keys are */
  binding: string;
  weight: bigint;
}

export interface ChurnParams {
  maxM: bigint;
  distNum: bigint;
  distDen: bigint;
}

export interface Measured {
  replaced: bigint;
  removed: bigint;
  added: bigint;
  m: bigint;
  unchangedOld: bigint;
  unchangedNew: bigint;
  totalOld: bigint;
  totalNew: bigint;
  /** D = distanceNumerator / (totalOld * totalNew) */
  distanceNumerator: bigint;
}

export const FAIL_MEMBERSHIP = 1;
export const FAIL_TURNOVER = 2;
export const FAIL_DISTANCE = 4;
export const FAIL_OVERLAP = 8;

export class InvalidCommittee extends Error {
  constructor(readonly successor: boolean) {
    super(`InvalidCommittee(${successor})`);
    this.name = 'InvalidCommittee';
  }
}

function total(c: Member[], successor: boolean): bigint {
  if (c.length === 0) throw new InvalidCommittee(successor);
  let t = 0n;
  c.forEach((m, i) => {
    if (m.weight === 0n || (i > 0 && m.id <= c[i - 1].id)) throw new InvalidCommittee(successor);
    t += m.weight;
  });
  if (t > U64_MAX) throw new InvalidCommittee(successor);
  return t;
}

const absDiff = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a);

export function measure(o: Member[], s: Member[]): Measured {
  const totalOld = total(o, false);
  const totalNew = total(s, true);
  const r: Measured = { replaced: 0n, removed: 0n, added: 0n, m: 0n, unchangedOld: 0n, unchangedNew: 0n, totalOld, totalNew, distanceNumerator: 0n };
  let onlyOld = 0n;
  let onlyNew = 0n;
  let i = 0;
  let j = 0;
  while (i < o.length || j < s.length) {
    if (j === s.length || (i < o.length && o[i].id < s[j].id)) {
      onlyOld++;
      r.distanceNumerator += o[i].weight * totalNew;
      i++;
    } else if (i === o.length || s[j].id < o[i].id) {
      onlyNew++;
      r.distanceNumerator += s[j].weight * totalOld;
      j++;
    } else {
      if (o[i].binding === s[j].binding) {
        r.unchangedOld += o[i].weight;
        r.unchangedNew += s[j].weight;
      } else r.replaced++;
      r.distanceNumerator += absDiff(s[j].weight * totalOld, o[i].weight * totalNew);
      i++;
      j++;
    }
  }
  r.removed = onlyOld + r.replaced;
  r.added = onlyNew + r.replaced;
  r.m = r.removed + r.added;
  return r;
}

export function judge(r: Measured, oldSize: number, newSize: number, p: ChurnParams): number {
  if (p.distDen === 0n) throw new Error('InvalidParams');
  let failed = 0;
  if (r.m > p.maxM) failed |= FAIL_MEMBERSHIP;
  const minSize = BigInt(Math.min(oldSize, newSize));
  const widest = r.removed > r.added ? r.removed : r.added;
  if (3n * widest >= minSize) failed |= FAIL_TURNOVER;
  if (r.distanceNumerator * p.distDen > p.distNum * r.totalOld * r.totalNew) failed |= FAIL_DISTANCE;
  if (3n * r.unchangedOld <= 2n * r.totalOld || 3n * r.unchangedNew <= 2n * r.totalNew) failed |= FAIL_OVERLAP;
  return failed;
}

export function check(o: Member[], s: Member[], p: ChurnParams): { failed: number; measured: Measured } {
  if (p.distDen === 0n) throw new Error('InvalidParams');
  const measured = measure(o, s);
  return { failed: judge(measured, o.length, s.length, p), measured };
}

/** One row per predicate, for the churn table: the value as a fraction, the bound, and whether it passes. */
export function predicates(r: Measured, oldSize: number, newSize: number, p: ChurnParams): { name: string; value: string; bound: string; ok: boolean }[] {
  const failed = judge(r, oldSize, newSize, p);
  const widest = r.removed > r.added ? r.removed : r.added;
  const minSize = Math.min(oldSize, newSize);
  const vw = r.totalOld * r.totalNew;
  return [
    { name: 'membership budget M = removed + added', value: `${r.m} (−${r.removed} +${r.added}${r.replaced ? `, ${r.replaced} re-keyed` : ''})`, bound: `≤ ${p.maxM}`, ok: !(failed & FAIL_MEMBERSHIP) },
    { name: 'turnover max(removed, added) / min(|O|, |S|)', value: `${widest}/${minSize}`, bound: '< 1/3', ok: !(failed & FAIL_TURNOVER) },
    { name: 'weight distance D = Σ|w/W − v/V|', value: `${fraction(r.distanceNumerator, vw)}`, bound: `≤ ${p.distNum}/${p.distDen}`, ok: !(failed & FAIL_DISTANCE) },
    { name: 'unchanged-binding overlap (old, new)', value: `${fraction(r.unchangedOld, r.totalOld)}, ${fraction(r.unchangedNew, r.totalNew)}`, bound: '> 2/3 each', ok: !(failed & FAIL_OVERLAP) },
  ];
}

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
export function fraction(n: bigint, d: bigint): string {
  if (d === 0n) return '—';
  if (n === 0n) return '0';
  const g = gcd(n, d);
  const dec = Number((n * 10000n) / d) / 10000;
  return d / g === 1n ? `${n / g}` : `${n / g}/${d / g} ≈ ${dec.toFixed(3)}`;
}

// ---- selection ----------------------------------------------------------------------------------------------------------------------------------
export interface SelectionConfig extends ChurnParams {
  nMin: number;
  nTarget: number;
  nMax: number;
}

/** Selection.Reason, which ElectionPolicy.Reason 1-4 mirror. */
export const SEL_REASON = ['None', 'InvalidProfile', 'Cardinality', 'MembershipChurn', 'WeightChurn'] as const;

const better = (a: Member, b: Member): boolean => (a.weight !== b.weight ? a.weight > b.weight : a.id < b.id);

function committee(e: Member[], inS: boolean[]): Member[] {
  const chosen = e.filter((_, i) => inS[i]);
  const q = quantize(chosen.map((m) => m.weight));
  return chosen.map((m, k) => ({ id: m.id, binding: m.binding, weight: q[k] }));
}

const churnReason = (failed: number): number => (failed & (FAIL_MEMBERSHIP | FAIL_TURNOVER) ? 3 : 4);

/**
 * The election over the eligible identities `e` (ascending by id, raw weights) against the last committed committee `o`: returns the
 * reason (an index into SEL_REASON) and the chosen committee (ascending, committed weights), empty on a refusal.
 */
export function select(o: Member[], e: Member[], cfg: SelectionConfig): { reason: number; chosen: Member[] } {
  if (cfg.nMin === 0 || cfg.nTarget < cfg.nMin || cfg.nMax < cfg.nTarget || cfg.nMax > 16 || cfg.distDen === 0n) return { reason: 1, chosen: [] };
  const n = e.length;
  for (let i = 0; i < n; i++) if (e[i].weight === 0n || (i > 0 && e[i].id <= e[i - 1].id)) throw new Error('InvalidEligible');
  if (n < cfg.nMin) return { reason: 2, chosen: [] };
  const oById = new Map(o.map((m) => [m.id, m]));
  const incumbent = e.map((m) => oById.has(m.id));
  const rank = e.map((_, i) => i).sort((a, b) => (better(e[a], e[b]) ? -1 : better(e[b], e[a]) ? 1 : 0));
  const inS: boolean[] = new Array<boolean>(n).fill(false);
  let count = 0;
  for (const r of rank) if (count < cfg.nTarget && incumbent[r]) {
    inS[r] = true;
    count++;
  }
  for (const r of rank) if (count < cfg.nTarget && !incumbent[r]) {
    inS[r] = true;
    count++;
  }
  let chosen = committee(e, inS);
  const seed = check(o, chosen, cfg);
  if (seed.failed !== 0) return feasible(o, e, cfg, rank, incumbent, churnReason(seed.failed));
  let q = n;
  let replacedAny = false;
  for (const x of rank) {
    if (incumbent[x] || inS[x]) continue;
    while (q > 0 && !(incumbent[rank[q - 1]] && inS[rank[q - 1]])) q--;
    if (q === 0) continue;
    const low = rank[q - 1];
    if (!better(e[x], e[low])) continue;
    inS[low] = false;
    inS[x] = true;
    if (check(o, committee(e, inS), cfg).failed === 0) replacedAny = true;
    else {
      inS[low] = true;
      inS[x] = false;
    }
  }
  if (replacedAny) chosen = committee(e, inS);
  return { reason: 0, chosen };
}

function feasible(o: Member[], e: Member[], cfg: SelectionConfig, rank: number[], incumbent: boolean[], seedReason: number): { reason: number; chosen: Member[] } {
  const inS: boolean[] = new Array<boolean>(e.length).fill(false);
  let count = 0;
  for (const r of rank) if (count < cfg.nTarget && incumbent[r]) {
    inS[r] = true;
    count++;
  }
  if (count === 0) return { reason: seedReason, chosen: [] };
  const incumbents = count;
  let trial = committee(e, inS);
  let failed = check(o, trial, cfg).failed;
  if (failed !== 0) return { reason: churnReason(failed), chosen: [] };
  let skipped = 0;
  for (const x of rank) {
    if (count >= cfg.nTarget) break;
    if (incumbent[x]) continue;
    inS[x] = true;
    const next = committee(e, inS);
    failed = check(o, next, cfg).failed;
    if (failed === 0) {
      trial = next;
      count++;
    } else {
      inS[x] = false;
      if (skipped === 0) skipped = churnReason(failed);
    }
  }
  if (skipped === 0) skipped = 2;
  if (count < cfg.nMin) return { reason: skipped, chosen: [] };
  const same = o.length === trial.length && o.every((m, i) => m.id === trial[i].id && m.binding === trial[i].binding && m.weight === trial[i].weight);
  if (count === incumbents && same) return { reason: skipped, chosen: [] };
  return { reason: 0, chosen: trial };
}
