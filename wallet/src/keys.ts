/**
 * One burner secp256k1 key: it is the EVM account (keccak of the public key) and the Unicity identity (a SignaturePredicate of the same key).
 * Backup: the 32-byte key as a 24-word BIP-39 mnemonic (the key is the mnemonic's entropy, no derivation path, so any key round-trips;
 * not a MetaMask-compatible seed) or as 0x hex.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { SigningService } from '@unicitylabs/state-transition-sdk/lib/crypto/secp256k1/SigningService.js';
import { SignaturePredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/builtin/SignaturePredicate.js';
import { EncodedPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/EncodedPredicate.js';

import { hex, unhex } from './hex.js';
import { load, save } from './store.js';

export interface Burner {
  secret: Uint8Array;
  /** 33-byte compressed public key */
  publicKey: Uint8Array;
  signer: SigningService;
  evmAddress: string;
  /** the Unicity owner predicate, CBOR (what a lock's p0 and a transfer's recipient carry) */
  predicate: Uint8Array;
}

export const evmAddressOf = (secret: Uint8Array): string =>
  `0x${hex(keccak_256(secp256k1.getPublicKey(secret, false).subarray(1)).subarray(12))}`;

export const predicateOf = (publicKey: Uint8Array): Uint8Array => EncodedPredicate.fromPredicate(SignaturePredicate.create(publicKey)).toCBOR();

export function burnerFrom(secret: Uint8Array): Burner {
  if (!secp256k1.utils.isValidSecretKey(secret)) throw new Error('not a valid secp256k1 secret key');
  const signer = new SigningService(secret);
  return { secret, publicKey: signer.publicKey, signer, evmAddress: evmAddressOf(secret), predicate: predicateOf(signer.publicKey) };
}

export const toMnemonic = (secret: Uint8Array): string => entropyToMnemonic(secret, wordlist);

/** A backup as typed: 24 words, or 0x + 64 hex digits. */
export function parseBackup(text: string): Uint8Array {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^(0x)?[0-9a-f]{64}$/.test(t)) return unhex(t);
  if (!validateMnemonic(t, wordlist)) throw new Error('neither a 0x-hex key nor a valid BIP-39 mnemonic');
  const e = mnemonicToEntropy(t, wordlist);
  if (e.length !== 32) throw new Error(`the mnemonic holds ${e.length * 8} bits; a key needs 256 (24 words)`);
  return e;
}

/** The stored burner, or a new one (saved before it is used). */
export function loadOrCreate(): { burner: Burner; created: boolean; persisted: boolean } {
  const stored = load('key');
  if (stored) {
    try {
      return { burner: burnerFrom(unhex(stored)), created: false, persisted: true };
    } catch {
      /* a damaged entry: start over */
    }
  }
  const secret = secp256k1.utils.randomSecretKey();
  return { burner: burnerFrom(secret), created: true, persisted: save('key', hex(secret)) };
}

export function replaceKey(secret: Uint8Array): Burner {
  const b = burnerFrom(secret);
  save('key', hex(secret));
  return b;
}
