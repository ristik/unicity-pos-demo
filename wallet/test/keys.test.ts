/** Keys and EVM signing against published vectors (EIP-155's example transaction, BIP-39's 256-bit vectors). */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rlpDecode } from '@unicitylabs/native-bridge-plugin';

import { calldata, decBytes, encBytes, LOCKED_TOPIC, rlpUint, selector, signLegacyTx } from '../src/evm.js';
import { fmtUnits, hex, parseUnits, unhex } from '../src/hex.js';
import { burnerFrom, evmAddressOf, parseBackup, predicateOf, toMnemonic } from '../src/keys.js';

const EIP155_KEY = unhex('4646464646464646464646464646464646464646464646464646464646464646');

test('EIP-155 example: signing hash, raw transaction and sender address', () => {
  const t = { nonce: 9n, gasPrice: 20_000_000_000n, gas: 21_000n, to: '0x3535353535353535353535353535353535353535', value: 10n ** 18n, data: new Uint8Array(), chainId: 1n };
  const r = signLegacyTx(t, EIP155_KEY);
  assert.equal(r.signingHash, '0xdaf5a779ae972f972197303d7b574746c7ef83eadac0f2791ad23db92e4c8e53');
  assert.equal(r.raw, '0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83');
  assert.equal(evmAddressOf(EIP155_KEY), '0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f');
});

test('a large chain id (staging 5587796) gives v = 2·id + 35/36', () => {
  const r = signLegacyTx({ nonce: 0n, gasPrice: 2_000_000n, gas: 100_000n, to: `0x${'aa'.repeat(20)}`, value: 1n, data: Uint8Array.of(1, 2, 3), chainId: 5587796n }, EIP155_KEY);
  const items = rlpDecode(unhex(r.raw));
  assert.equal(items.kind, 'list');
  const vb = items.kind === 'list' ? items.items[6] : undefined;
  const v = BigInt(`0x${hex(vb && vb.kind === 'bytes' ? vb.data : new Uint8Array())}`);
  assert.ok(v === 5587796n * 2n + 35n || v === 5587796n * 2n + 36n, `v = ${v}`);
});

test('RLP integers are minimal', () => {
  assert.equal(hex(rlpUint(0n)), '80');
  assert.equal(hex(rlpUint(1n)), '01');
  assert.equal(hex(rlpUint(0x80n)), '8180');
  assert.equal(hex(rlpUint(1024n)), '820400');
});

test('BIP-39: the 256-bit vectors round-trip as keys', () => {
  const v1 = '7f'.repeat(32);
  const w1 = 'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title';
  const v2 = '80'.repeat(32);
  const w2 = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless';
  assert.equal(toMnemonic(unhex(v1)), w1);
  assert.equal(toMnemonic(unhex(v2)), w2);
  assert.equal(hex(parseBackup(`  ${w1.toUpperCase()}\n`)), v1);
  assert.equal(hex(parseBackup(`0x${v2}`)), v2);
});

test('backups that are not a key are refused', () => {
  assert.throws(() => parseBackup('legal winner thank year wave sausage worth useful legal winner thank yellow'), /BIP-39|256/);
  assert.throws(() => parseBackup('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), /256 \(24 words\)/);
  assert.throws(() => burnerFrom(new Uint8Array(32)), /secret key/);
  assert.throws(() => parseBackup('0x1234'), /neither/);
});

test('one key: the EVM address and the Unicity owner predicate', () => {
  const b = burnerFrom(EIP155_KEY);
  assert.equal(b.evmAddress, '0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f');
  assert.equal(b.publicKey.length, 33);
  assert.deepEqual(b.predicate, predicateOf(b.publicKey));
});

test('ABI: selectors, bytes argument and the Locked topic', () => {
  assert.equal(selector('redeem(bytes)'), '9945e3d3');
  assert.equal(selector('transfer(address,uint256)'), 'a9059cbb');
  const b = Uint8Array.from({ length: 33 }, (_, i) => i);
  const enc = encBytes(b);
  assert.equal(enc.length, 64 * 4);
  assert.deepEqual(decBytes(`0x${enc}`), b);
  assert.equal(hex(calldata('lock(bytes)', enc)).slice(0, 8), selector('lock(bytes)'));
  assert.match(LOCKED_TOPIC, /^0x[0-9a-f]{64}$/);
});

test('UCT amounts', () => {
  assert.equal(parseUnits('0.001'), 10n ** 15n);
  assert.equal(fmtUnits(1_500_000_000_000_000_000n), '1.5');
  assert.equal(fmtUnits(0n), '0');
  assert.throws(() => parseUnits('1.0000000000000000001'));
});
