/**
 * The wallet's durable store: one IndexedDB object store, keys namespaced by the wallet profile. It is the plug-in's JournalStore, and it
 * also holds the wallet's token records, so everything the bridge guide says must survive a crash goes through one place.
 *
 * `putIf` is the journal contract (native-bridge-plugins docs/nb2-journal.md): a compare-and-swap that is atomic and resolves only after
 * the value is durable. Here that is ONE readwrite transaction (read, compare, write), opened with `durability: 'strict'`, and the promise
 * resolves on the transaction's `complete` event, never earlier. IndexedDB serializes readwrite transactions on the same store, so no
 * other write can land between the comparison and the write, in this tab or another. One writer per profile is still required, because
 * the plug-in keeps per-record state in memory: {@link acquireWriter} takes a Web Lock for the profile for the life of the page.
 */

const DB_NAME = 'unicity-demo-nb2';
const STORE = 'kv';

export class StoreUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreUnavailable';
  }
}

const done = (tx: IDBTransaction): Promise<void> => new Promise((ok, fail) => {
  tx.oncomplete = () => ok();
  tx.onerror = () => fail(tx.error ?? new Error('IndexedDB transaction failed'));
  tx.onabort = () => fail(tx.error ?? new Error('IndexedDB transaction aborted'));
});

export class IdbKv {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly ns: string, private readonly factory: IDBFactory | undefined = globalThis.indexedDB) {}

  private open(): Promise<IDBDatabase> {
    if (!this.factory) throw new StoreUnavailable('IndexedDB is not available in this browser: the wallet cannot keep a durable journal, so it will not move value');
    this.db ??= new Promise<IDBDatabase>((ok, fail) => {
      const r = this.factory!.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => fail(new StoreUnavailable(`IndexedDB could not be opened: ${r.error?.message ?? 'unknown error'}`));
      r.onblocked = () => fail(new StoreUnavailable('IndexedDB is blocked by another tab holding an older version'));
    });
    return this.db;
  }

  private k = (key: string): string => `${this.ns}\u0000${key}`;

  async get(key: string): Promise<string | null> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(this.k(key));
    await done(tx);
    return (req.result as string | undefined) ?? null;
  }

  /** The compare-and-swap of the journal contract: one durable readwrite transaction. */
  async putIf(key: string, expected: string | null, value: string): Promise<boolean> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
    const st = tx.objectStore(STORE);
    let swapped = false;
    const get = st.get(this.k(key));
    get.onsuccess = () => {
      if (((get.result as string | undefined) ?? null) !== expected) return;
      swapped = true;
      st.put(value, this.k(key));
    };
    await done(tx); // 'complete' fires once the transaction is committed (strict durability: flushed)
    return swapped;
  }

  /** An unconditional durable write (the wallet's own records, which have one writer). */
  async put(key: string, value: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
    tx.objectStore(STORE).put(value, this.k(key));
    await done(tx);
  }

  async delete(key: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
    tx.objectStore(STORE).delete(this.k(key));
    await done(tx);
  }

  /** Every [key, value] whose key starts with PREFIX, in key order. */
  async entries(prefix: string): Promise<[string, string][]> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readonly');
    const lo = this.k(prefix);
    const req = tx.objectStore(STORE).openCursor(IDBKeyRange.bound(lo, `${lo}￿`));
    const out: [string, string][] = [];
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      out.push([String(c.key).slice(this.ns.length + 1), c.value as string]);
      c.continue();
    };
    await done(tx);
    return out;
  }

  /** Delete every key of this profile (a key replacement starts a new journal: the old one belongs to the old key's secret). */
  async clear(): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
    const lo = `${this.ns}\u0000`;
    tx.objectStore(STORE).delete(IDBKeyRange.bound(lo, `${lo}\uffff`));
    await done(tx);
  }

  async list(prefix: string): Promise<string[]> {
    return (await this.entries(prefix)).map(([k]) => k);
  }

  close(): void {
    void this.db?.then((d) => d.close());
    this.db = null;
  }
}

/**
 * One writer per profile: a Web Lock held until the page goes away. Returns null when another page of this profile holds it (this one must
 * not write). Where Web Locks do not exist the page is let through, and says so (`exclusive: false`).
 */
export async function acquireWriter(profile: string): Promise<{ exclusive: boolean } | null> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (!locks) return { exclusive: false };
  return new Promise((resolve) => {
    void locks.request(`unicity-demo-writer:${profile}`, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(null);
        return undefined;
      }
      resolve({ exclusive: true });
      return new Promise<void>(() => undefined); // held for the life of the page
    });
  });
}
