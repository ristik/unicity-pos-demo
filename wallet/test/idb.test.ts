/**
 * The durable store (src/idb.ts) against the plug-in's own journal-store contract check (checkJournalStore: compare-and-swap, atomicity under
 * concurrent writers, persistence across a reopen, sorted list), on fake-indexeddb; and the token records written through it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkJournalStore } from '@unicitylabs/native-bridge-plugin/nb2';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import { hex } from '../src/hex.js';
import { acquireWriter, IdbKv, StoreUnavailable } from '../src/idb.js';
import { loadOrCreateDurable } from '../src/keys.js';
import { getToken, initTokens, listTokens, patchToken, putToken, putTokens } from '../src/tokens.js';

// the browser has IDBKeyRange as a global
(globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = IDBKeyRange;

test('IdbKv meets the journal store contract', async () => {
  const factories = new Map<IdbKv, IDBFactory>();
  await checkJournalStore(
    () => {
      const f = new IDBFactory();
      const kv = new IdbKv('a', f);
      factories.set(kv, f);
      return kv;
    },
    (kv) => new IdbKv('a', factories.get(kv)),
    16,
  );
});

test('putIf resolves only after its transaction committed, in strict durability', async () => {
  const f = new IDBFactory();
  const seen: (string | undefined)[] = [];
  const open = f.open.bind(f);
  f.open = ((name: string, version?: number) => {
    const req = open(name, version);
    req.addEventListener('success', () => {
      const db = req.result;
      const tx = db.transaction.bind(db);
      db.transaction = ((stores: string | string[], mode?: IDBTransactionMode, opts?: IDBTransactionOptions) => {
        if (mode === 'readwrite') seen.push(opts?.durability);
        return tx(stores, mode, opts);
      }) as typeof db.transaction;
    });
    return req;
  }) as typeof f.open;
  const kv = new IdbKv('p', f);
  assert.equal(await kv.putIf('k', null, 'v1'), true);
  assert.equal(await kv.putIf('k', null, 'v2'), false);
  assert.equal(await kv.get('k'), 'v1');
  assert.deepEqual(seen, ['strict', 'strict']);
});

test('profiles do not see each other, and clear removes only its own', async () => {
  const f = new IDBFactory();
  const a = new IdbKv('a', f);
  const b = new IdbKv('b', f);
  await a.put('x/1', '1');
  await b.put('x/1', '2');
  assert.deepEqual(await a.list('x/'), ['x/1']);
  await a.clear();
  assert.equal(await a.get('x/1'), null);
  assert.equal(await b.get('x/1'), '2');
});

test('without IndexedDB the store refuses, naming why', async () => {
  const kv = new IdbKv('a', undefined);
  await assert.rejects(() => kv.get('k'), StoreUnavailable);
});

test('token records are durable before the write resolves, and reload from the store', async () => {
  const f = new IDBFactory();
  const kv = new IdbKv('a', f);
  await initTokens(kv, 'D.k');
  await putToken({ id: 'd0', amountWei: '100', phase: 'planned', intent: '0' });
  await patchToken('d0', { phase: 'deposited', depositNumber: '33' });
  await patchToken('d0', { depositNumber: undefined });
  assert.equal(getToken('d0')?.depositNumber, undefined);
  // a new page: the records come from the store, not from memory
  await initTokens(new IdbKv('a', f), 'D.k');
  assert.deepEqual(listTokens().map((t) => [t.id, t.phase]), [['d0', 'deposited']]);
  await assert.rejects(() => patchToken('nope', {}), /no token record/);
});

test('a failed write leaves memory and the store the same, so a retry cannot act on a request that was never committed', async () => {
  const f = new IDBFactory();
  const kv = new IdbKv('a', f);
  await initTokens(kv, 'D.k');
  await putToken({ id: 't', amountWei: '1', phase: 'minted', bytes: 'aa' });
  const real = kv.putMany.bind(kv);
  kv.putMany = async () => { throw new Error('the transaction aborted'); };
  await assert.rejects(() => patchToken('t', { pending: { tx: '01', cd: '02', at: 0, toPublicKey: '', toProfile: 'b', signer: '' } }), /aborted/);
  assert.equal(getToken('t')?.pending, undefined, 'no pending request in memory');
  kv.putMany = real;
  await initTokens(new IdbKv('a', f), 'D.k');
  assert.equal(getToken('t')?.pending, undefined, 'and none in the store');
});

test('records are scoped to the deployment and key: another scope neither sees nor overwrites them', async () => {
  const f = new IDBFactory();
  const kv = new IdbKv('a', f);
  await initTokens(kv, 'domainA.key1');
  await putToken({ id: 'd0', amountWei: '1', phase: 'sent', bytes: 'sent-token' });
  await initTokens(kv, 'domainB.key1');
  assert.deepEqual(listTokens(), []);
  await putToken({ id: 'd0', amountWei: '2', phase: 'planned', intent: '0' });
  await initTokens(kv, 'domainA.key2');
  assert.deepEqual(listTokens(), []);
  await initTokens(kv, 'domainA.key1');
  assert.deepEqual(listTokens().map((t) => [t.id, t.phase, t.bytes]), [['d0', 'sent', 'sent-token']]);
});

test('putTokens is atomic: all records or none', async () => {
  const f = new IDBFactory();
  const kv = new IdbKv('a', f);
  await initTokens(kv, 'D.k');
  await putTokens([{ id: 'p', amountWei: '1', phase: 'splitting' }]);
  const real = kv.putMany.bind(kv);
  kv.putMany = async () => { throw new Error('abort'); };
  await assert.rejects(() => putTokens([{ id: 'p.keep', amountWei: '1', phase: 'minted' }, { id: 'p', amountWei: '1', phase: 'split' }]));
  kv.putMany = real;
  assert.deepEqual(listTokens().map((t) => [t.id, t.phase]), [['p', 'splitting']]);
  await putTokens([{ id: 'p.keep', amountWei: '1', phase: 'minted' }, { id: 'p', amountWei: '1', phase: 'split' }]);
  await initTokens(new IdbKv('a', f), 'D.k');
  assert.deepEqual(listTokens().map((t) => [t.id, t.phase]), [['p', 'split'], ['p.keep', 'minted']]);
});

test('the burner key is committed to the durable store before it is used, and restored from it', async () => {
  const f = new IDBFactory();
  const kv = new IdbKv('a', f);
  const a = await loadOrCreateDurable(kv);
  assert.equal(a.created, true);
  assert.equal(await kv.get('secret/key'), hex(a.burner.secret));
  const b = await loadOrCreateDurable(new IdbKv('a', f));
  assert.equal(b.created, false);
  assert.equal(hex(b.burner.secret), hex(a.burner.secret));
  const broken = new IdbKv('x', new IDBFactory());
  broken.put = async () => { throw new Error('no space'); };
  await assert.rejects(() => loadOrCreateDurable(broken), /no space/);
});

test('without Web Locks, or when another page holds the lock, the writer is refused', async () => {
  const nav = globalThis.navigator as unknown as { locks?: unknown };
  const had = Object.getOwnPropertyDescriptor(nav, 'locks');
  try {
    Object.defineProperty(nav, 'locks', { value: undefined, configurable: true });
    const none = await acquireWriter('p');
    assert.equal(none.ok, false);
    const held = new Set<string>();
    Object.defineProperty(nav, 'locks', { configurable: true, value: {
      request: (name: string, _o: unknown, cb: (l: unknown) => unknown) => { if (held.has(name)) return Promise.resolve(cb(null)); held.add(name); return Promise.resolve(cb({ name })); },
    } });
    assert.deepEqual(await acquireWriter('p'), { ok: true });
    const second = await acquireWriter('p');
    assert.equal(second.ok, false);
    assert.match(!second.ok ? second.problem : '', /another page/);
    assert.deepEqual(await acquireWriter('q'), { ok: true });
  } finally {
    if (had) Object.defineProperty(nav, 'locks', had); else delete nav.locks;
  }
});
