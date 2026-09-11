// ══════════════════════════════════════════════════════════
//  fake-indexeddb — 테스트 전용 최소 IndexedDB 대역.
//
//  src/js/storage.js 의 IndexedDB 백엔드를 Node에서 그대로 돌려서 SQLite
//  백엔드와 결과가 같은지 비교하려고 만든 것이다. storage.js가 실제로 쓰는
//  기능만 구현한다: open/onupgradeneeded, createObjectStore(keyPath,
//  autoIncrement)/createIndex, transaction/objectStore, get/put/delete/clear/
//  count/getAll, openCursor(store/index, IDBKeyRange.only), oncomplete.
//  요청 결과와 트랜잭션 완료는 실제 브라우저처럼 비동기(setImmediate)로 온다.
// ══════════════════════════════════════════════════════════
'use strict';

function compareKeys(a, b) {
  const ta = typeof a, tb = typeof b;
  if (ta !== tb) return ta === 'number' ? -1 : 1;
  return a < b ? -1 : (a > b ? 1 : 0);
}

class FakeRequest {
  constructor(transaction) {
    this.transaction = transaction;
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
    this.onupgradeneeded = null;
  }
}

class FakeTransaction {
  constructor(db, names, mode) {
    this.db = db;
    this.names = names;
    this.mode = mode;
    this.pending = 0;
    this.finished = false;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this._scheduleFinish();
  }

  objectStore(name) {
    if (!this.names.includes(name)) throw new Error('object store not in transaction: ' + name);
    return new FakeObjectStore(this, this.db.stores.get(name));
  }

  _request(fn) {
    const req = new FakeRequest(this);
    this.pending++;
    setImmediate(() => {
      try {
        req.result = fn();
        if (req.onsuccess) req.onsuccess({ target: req });
      } catch (err) {
        req.error = err;
        this.error = err;
        if (req.onerror) req.onerror({ target: req });
      }
      this.pending--;
      this._scheduleFinish();
    });
    return req;
  }

  _scheduleFinish() {
    setImmediate(() => {
      if (this.finished || this.pending > 0) return;
      this.finished = true;
      if (this.error) { if (this.onerror) this.onerror({ target: this }); }
      else if (this.oncomplete) this.oncomplete({ target: this });
    });
  }
}

class FakeObjectStore {
  constructor(tx, store) {
    this.tx = tx;
    this.store = store;
  }

  _keyFor(value, explicitKey) {
    if (explicitKey !== undefined) return explicitKey;
    const s = this.store;
    if (s.keyPath) {
      let k = value[s.keyPath];
      if (k === undefined && s.autoIncrement) { k = s.nextKey++; value[s.keyPath] = k; }
      if (k === undefined) throw new Error('missing key ' + s.keyPath);
      if (typeof k === 'number' && s.autoIncrement && k >= s.nextKey) s.nextKey = k + 1;
      return k;
    }
    return s.nextKey++;
  }

  put(value, key) {
    const copy = structuredClone(value);
    return this.tx._request(() => {
      const k = this._keyFor(copy, key);
      this.store.records.set(k, copy);
      return k;
    });
  }

  add(value, key) { return this.put(value, key); }

  get(key) {
    return this.tx._request(() => {
      const v = this.store.records.get(key);
      return v === undefined ? undefined : structuredClone(v);
    });
  }

  delete(key) { return this.tx._request(() => { this.store.records.delete(key); return undefined; }); }
  clear() { return this.tx._request(() => { this.store.records.clear(); return undefined; }); }
  count() { return this.tx._request(() => this.store.records.size); }

  getAll() {
    return this.tx._request(() => [...this.store.records.entries()]
      .sort((a, b) => compareKeys(a[0], b[0]))
      .map(([, v]) => structuredClone(v)));
  }

  index(name) {
    const keyPath = this.store.indexes.get(name);
    if (!keyPath) throw new Error('unknown index ' + name);
    return { openCursor: range => this._openCursor(keyPath, range) };
  }

  openCursor(range) { return this._openCursor(null, range); }

  _openCursor(indexKeyPath, range) {
    const tx = this.tx;
    const req = new FakeRequest(tx);
    tx.pending++;
    const entries = [...this.store.records.entries()]
      .map(([k, v]) => ({ k, ik: indexKeyPath ? v[indexKeyPath] : k, v }))
      .filter(e => !range || range.includes(e.ik))
      .sort((a, b) => compareKeys(a.ik, b.ik) || compareKeys(a.k, b.k));
    let i = 0;
    const step = () => setImmediate(() => {
      if (i < entries.length) {
        const e = entries[i++];
        req.result = { key: e.ik, primaryKey: e.k, value: structuredClone(e.v), continue: step };
        if (req.onsuccess) req.onsuccess({ target: req });
      } else {
        req.result = null;
        if (req.onsuccess) req.onsuccess({ target: req });
        tx.pending--;
        tx._scheduleFinish();
      }
    });
    step();
    return req;
  }
}

class FakeDatabase {
  constructor(name) {
    this.name = name;
    this.version = 0;
    this.stores = new Map();
    this.objectStoreNames = { contains: n => this.stores.has(n) };
  }

  createObjectStore(name, opts) {
    const store = {
      name,
      keyPath: opts && opts.keyPath,
      autoIncrement: !!(opts && opts.autoIncrement),
      records: new Map(),
      indexes: new Map(),
      nextKey: 1,
    };
    this.stores.set(name, store);
    return { createIndex: (indexName, keyPath) => { store.indexes.set(indexName, keyPath); } };
  }

  transaction(names, mode) { return new FakeTransaction(this, [].concat(names), mode || 'readonly'); }
  close() {}
}

function createFakeIndexedDB() {
  const databases = new Map();
  const indexedDB = {
    open(name, version) {
      const req = new FakeRequest(null);
      setImmediate(() => {
        let db = databases.get(name);
        if (!db) { db = new FakeDatabase(name); databases.set(name, db); }
        req.result = db;
        const target = version || 1;
        if (target > db.version) {
          db.version = target;
          if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
        }
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
  };
  const IDBKeyRange = { only: value => ({ includes: k => compareKeys(k, value) === 0 }) };
  // 테스트에서 "구버전이 저장해둔 그대로의 행"을 넣어보기 위한 직접 접근
  function rawStore(dbName, storeName) {
    const db = databases.get(dbName);
    return db ? db.stores.get(storeName).records : null;
  }
  return { indexedDB, IDBKeyRange, rawStore };
}

module.exports = { createFakeIndexedDB };
