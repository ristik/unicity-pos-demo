import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REFERENCE_POLICY, defaultPayerPolicy, readPayerPolicy } from '../src/recovery.js';

test('default payer policy follows the release limits and the gateway gas price', () => {
  const p = readPayerPolicy(defaultPayerPolicy({ gas: 30_000_000n, signedBytes: 131_072n, calldataBytes: 65_536n, gasPrice: 5_000_000n }));
  assert.equal(p.gas, 30_000_000n);
  assert.equal(p.signedBytes, 131_072);
  assert.equal(p.calldataBytes, 65_536);
  assert.equal(p.maxFeePerGas, 50_000_000n);
  assert.equal(p.maxPriorityFeePerGas, 5_000_000n);
  assert.equal(p.maxTransactionFee, 30_000_000n * 50_000_000n);
  assert.equal(p.feeBudget, REFERENCE_POLICY.feeBudget);
  assert.equal(p.maxNonce, 100n);
  assert.deepEqual(p.archives, []);
});

test('default payer policy reproduces the reference policy at the reference price and floors a lower one', () => {
  const ref = { gas: 24_000_000n, signedBytes: 524_288, calldataBytes: 393_216, gasPrice: 1_000_000n };
  const p = readPayerPolicy(defaultPayerPolicy(ref));
  assert.equal(p.maxFeePerGas, 10_000_000n);
  assert.equal(p.maxPriorityFeePerGas, 1_000_000n);
  assert.equal(p.maxTransactionFee, 240_000_000_000_000n);
  assert.deepEqual(readPayerPolicy(defaultPayerPolicy({ ...ref, gasPrice: 7n })), p);
});

test('default payer policy falls back to the reference constants', () => {
  const p = readPayerPolicy(defaultPayerPolicy({}));
  assert.equal(p.gas, 24_000_000n);
  assert.equal(p.signedBytes, 524_288);
  assert.equal(p.calldataBytes, 393_216);
  assert.equal(p.maxFeePerGas, 10_000_000n);
});
