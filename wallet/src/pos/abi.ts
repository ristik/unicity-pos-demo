/**
 * A small Solidity ABI codec for the read surface of the PoS contracts: a parser for human-readable output lists
 * ("address owner,(uint64 id,bytes32 binding,uint64 weight)[] o"), a decoder of eth_call return data into named objects, and an encoder for
 * the few static argument types the views take. No dependency beyond keccak; enough for views, not a general ABI library.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';

import { hex, unhex } from '../hex.js';

export type AbiType =
  | { kind: 'uint' | 'int'; bits: number }
  | { kind: 'address' | 'bool' | 'bytes' | 'string' }
  | { kind: 'fixed'; size: number }
  | { kind: 'array'; of: AbiType; length: number | null }
  | { kind: 'tuple'; fields: { name: string; type: AbiType }[] };

/** A decoded value: bigint for integers, 0x-hex for addresses and bytes, nested objects/arrays for tuples/arrays. */
export type Value = bigint | boolean | string | Value[] | { [k: string]: Value };

// ---- parsing ------------------------------------------------------------------------------------------------------------------------------------
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim());
}

/** "uint64 id" / "(uint64 a,bytes b)[] xs" → a named type. */
export function parseParam(s: string, index = 0): { name: string; type: AbiType } {
  s = s.trim();
  let base: AbiType;
  let rest: string;
  if (s.startsWith('(')) {
    let depth = 0;
    let end = -1;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      if (s[i] === ')' && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error(`unbalanced: ${s}`);
    base = parseTuple(s.slice(1, end));
    rest = s.slice(end + 1);
  } else {
    const m = /^([a-z0-9]+)(.*)$/.exec(s);
    if (!m) throw new Error(`bad type: ${s}`);
    base = elementary(m[1]);
    rest = m[2];
  }
  // array suffixes, then an optional name
  const m = /^((?:\[\d*\])*)\s*([A-Za-z_$][\w$]*)?$/.exec(rest.trim());
  if (!m) throw new Error(`bad type suffix: ${s}`);
  for (const dim of m[1].match(/\[\d*\]/g) ?? []) base = { kind: 'array', of: base, length: dim === '[]' ? null : Number(dim.slice(1, -1)) };
  return { name: m[2] ?? String(index), type: base };
}

export const parseTuple = (s: string): AbiType => ({ kind: 'tuple', fields: splitTop(s).map((p, i) => parseParam(p, i)) });

function elementary(t: string): AbiType {
  if (t === 'address' || t === 'bool' || t === 'bytes' || t === 'string') return { kind: t };
  let m = /^(u?int)(\d*)$/.exec(t);
  if (m) return { kind: m[1] as 'uint' | 'int', bits: Number(m[2] || 256) };
  m = /^bytes(\d+)$/.exec(t);
  if (m) return { kind: 'fixed', size: Number(m[1]) };
  throw new Error(`unsupported type ${t}`);
}

export function canonical(t: AbiType): string {
  switch (t.kind) {
    case 'uint':
    case 'int':
      return `${t.kind}${t.bits}`;
    case 'fixed':
      return `bytes${t.size}`;
    case 'array':
      return `${canonical(t.of)}[${t.length ?? ''}]`;
    case 'tuple':
      return `(${t.fields.map((f) => canonical(f.type)).join(',')})`;
    default:
      return t.kind;
  }
}

const isDynamic = (t: AbiType): boolean =>
  t.kind === 'bytes' || t.kind === 'string' || (t.kind === 'array' && (t.length === null || isDynamic(t.of))) || (t.kind === 'tuple' && t.fields.some((f) => isDynamic(f.type)));

/** The head size of a static type, in bytes. */
const headSize = (t: AbiType): number =>
  isDynamic(t) ? 32 : t.kind === 'tuple' ? t.fields.reduce((a, f) => a + headSize(f.type), 0) : t.kind === 'array' ? (t.length ?? 0) * headSize(t.of) : 32;

// ---- decoding -----------------------------------------------------------------------------------------------------------------------------------
const MAX_LEN = 1 << 20;

function wordAt(b: Uint8Array, off: number): bigint {
  if (off + 32 > b.length) throw new Error(`ABI: read past the end (${off + 32} > ${b.length})`);
  return BigInt(`0x${hex(b.subarray(off, off + 32))}`);
}
const smallAt = (b: Uint8Array, off: number): number => {
  const v = wordAt(b, off);
  if (v > BigInt(MAX_LEN) * 32n) throw new Error('ABI: offset or length too large');
  return Number(v);
};

function decodeAt(t: AbiType, b: Uint8Array, base: number, off: number): Value {
  if (isDynamic(t)) {
    // a dynamic value's head is its offset from the enclosing tuple's start
    const at = base + smallAt(b, off);
    return decodeTail(t, b, at);
  }
  return decodeStatic(t, b, base, off);
}

function decodeStatic(t: AbiType, b: Uint8Array, base: number, off: number): Value {
  switch (t.kind) {
    case 'uint':
      return wordAt(b, off);
    case 'int': {
      const v = wordAt(b, off);
      return v >= 1n << 255n ? v - (1n << 256n) : v;
    }
    case 'bool':
      return wordAt(b, off) !== 0n;
    case 'address':
      return `0x${hex(b.subarray(off + 12, off + 32))}`;
    case 'fixed':
      return `0x${hex(b.subarray(off, off + t.size))}`;
    case 'tuple':
      return decodeFields(t.fields, b, off);
    case 'array': {
      const out: Value[] = [];
      let o = off;
      for (let i = 0; i < (t.length ?? 0); i++) {
        out.push(decodeAt(t.of, b, off, o));
        o += headSize(t.of);
      }
      return out;
    }
    default:
      throw new Error(`ABI: ${t.kind} is not static`);
  }
}

function decodeTail(t: AbiType, b: Uint8Array, at: number): Value {
  switch (t.kind) {
    case 'bytes':
    case 'string': {
      const len = smallAt(b, at);
      if (at + 32 + len > b.length) throw new Error('ABI: bytes past the end');
      const raw = b.subarray(at + 32, at + 32 + len);
      return t.kind === 'string' ? new TextDecoder().decode(raw) : `0x${hex(raw)}`;
    }
    case 'array': {
      let n = t.length;
      let start = at;
      if (n === null) {
        n = smallAt(b, at);
        start = at + 32;
      }
      if (n > 4096) throw new Error('ABI: array too long');
      const out: Value[] = [];
      for (let i = 0; i < n; i++) out.push(decodeAt(t.of, b, start, start + i * headSize(t.of)));
      return out;
    }
    case 'tuple':
      return decodeFields(t.fields, b, at);
    default:
      throw new Error(`ABI: ${t.kind} is not dynamic`);
  }
}

function decodeFields(fields: { name: string; type: AbiType }[], b: Uint8Array, base: number): { [k: string]: Value } {
  const out: { [k: string]: Value } = {};
  let off = base;
  for (const f of fields) {
    out[f.name] = decodeAt(f.type, b, base, off);
    off += headSize(f.type);
  }
  return out;
}

/** Decode return data against an output list ("uint64 id,bytes32 h"). One unnamed output is returned bare. */
export function decode(outputs: string, data: string | Uint8Array): Value {
  const b = typeof data === 'string' ? unhex(data) : data;
  const t = parseTuple(outputs) as Extract<AbiType, { kind: 'tuple' }>;
  if (t.fields.length === 0) return {};
  const v = decodeFields(t.fields, b, 0);
  return t.fields.length === 1 && t.fields[0].name === '0' ? v['0'] : v;
}

// ---- encoding (static arguments, and arrays of them) -------------------------------------------------------------------------------------------
const word = (n: bigint): string => {
  if (n < 0n) n += 1n << 256n;
  return n.toString(16).padStart(64, '0');
};

export type Arg = bigint | number | string | boolean | Arg[];

function encodeStatic(t: AbiType, v: Arg): string {
  switch (t.kind) {
    case 'uint':
    case 'int':
      return word(BigInt(v as bigint | number | string));
    case 'bool':
      return word(v ? 1n : 0n);
    case 'address':
      return String(v).replace(/^0x/, '').toLowerCase().padStart(64, '0');
    case 'fixed':
      return String(v).replace(/^0x/, '').toLowerCase().padEnd(64, '0');
    default:
      throw new Error(`encode: ${t.kind} arguments are not supported`);
  }
}

/** abi.encode of arguments: static elementary types and dynamic arrays of them. */
export function encodeArgs(types: string[], args: Arg[]): string {
  const ts = types.map((s) => parseParam(s).type);
  let head = '';
  let tail = '';
  const headLen = ts.length * 32;
  ts.forEach((t, i) => {
    if (t.kind === 'array' && t.length === null) {
      head += word(BigInt(headLen + tail.length / 2));
      const xs = args[i] as Arg[];
      tail += word(BigInt(xs.length)) + xs.map((x) => encodeStatic(t.of, x)).join('');
    } else head += encodeStatic(t, args[i]);
  });
  return head + tail;
}

export const selectorOf = (signature: string): string => hex(keccak_256(new TextEncoder().encode(signature)).subarray(0, 4));

/** "positions(uint64)" → its canonical signature and argument types. */
export function parseSignature(sig: string): { name: string; inputs: string[]; canonical: string } {
  const m = /^(\w+)\((.*)\)$/.exec(sig.replace(/\s+/g, ' ').trim());
  if (!m) throw new Error(`bad signature ${sig}`);
  const t = parseTuple(m[2]) as Extract<AbiType, { kind: 'tuple' }>;
  const inputs = t.fields.map((f) => canonical(f.type));
  return { name: m[1], inputs, canonical: `${m[1]}(${inputs.join(',')})` };
}

/** keccak256(abi.encode(bytes32, bytes32, bytes32)): the signing binding the continuity rule compares. */
export function keccakWords(...words: string[]): string {
  return `0x${hex(keccak_256(unhex(words.map((w) => w.replace(/^0x/, '').padStart(64, '0')).join(''))))}`;
}
export const keccakHex = (data: string): string => `0x${hex(keccak_256(unhex(data)))}`;
export const SIGNING_DOMAIN = `0x${hex(keccak_256(new TextEncoder().encode('unicity.p85.signing-binding')))}`;
/** EligibilityReader.committed's binding: keccak256(abi.encode(SIGNING_DOMAIN, rootKeyHash, evmKeyHash)). */
export const signingBinding = (rootKeyHash: string, evmKeyHash: string): string => keccakWords(SIGNING_DOMAIN, rootKeyHash, evmKeyHash);
