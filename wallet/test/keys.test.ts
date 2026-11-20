/** Keys against published vectors (EIP-155's example key, BIP-39's 256-bit vectors). */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LocalKeySigner } from '@unicitylabs/native-bridge-plugin/nb2';

import { fmtUnits, hex, parseUnits, unhex } from '../src/hex.js';
import { burnerFrom, evmAddressOf, parseBackup, predicateOf, toMnemonic } from '../src/keys.js';

const EIP155_KEY = unhex('4646464646464646464646464646464646464646464646464646464646464646');

test('the EIP-155 example key has the published address', () => {
  assert.equal(evmAddressOf(EIP155_KEY), '0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f');
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

test('the plug-in\'s EVM signer and the wallet agree on the burner\'s address', () => {
  assert.equal(`0x${hex(new LocalKeySigner(EIP155_KEY).address)}`, evmAddressOf(EIP155_KEY));
});

test('UCT amounts', () => {
  assert.equal(parseUnits('0.001'), 10n ** 15n);
  assert.equal(fmtUnits(1_500_000_000_000_000_000n), '1.5');
  assert.equal(fmtUnits(0n), '0');
  assert.throws(() => parseUnits('1.0000000000000000001'));
});
