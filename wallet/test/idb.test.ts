/**
 * The durable store (src/idb.ts) against the plug-in's own journal-store contract check (checkJournalStore: compare-and-swap, atomicity under
 * concurrent writers, persistence across a reopen, sorted list), on fake-indexeddb; and the token records written through it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkJournalStore } from '@unicitylabs/native-bridge-plugin/nb2';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import { IdbKv, StoreUnavailable } from '../src/idb.js';
import { getToken, initTokens, listTokens, patchToken, putToken } from '../src/tokens.js';

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
  await initTokens(kv);
  await putToken({ id: 'd0', amountWei: '100', phase: 'planned', intent: '0' });
  await patchToken('d0', { phase: 'deposited', depositNumber: '33' });
  await patchToken('d0', { depositNumber: undefined });
  assert.equal(getToken('d0')?.depositNumber, undefined);
  // a new page: the records come from the store, not from memory
  await initTokens(new IdbKv('a', f));
  assert.deepEqual(listTokens().map((t) => [t.id, t.phase]), [['d0', 'deposited']]);
  await assert.rejects(() => patchToken('nope', {}), /no token record/);
});
