/**
 * 内存版云开发数据库。
 *
 * 只实现 repo.js / sync repo.js 真正用到的那几个方法，但语义按官方文档对齐：
 *   - doc(id).get() 在文档不存在时必须 reject（云开发就是这样，代码里有 catch 兜底）
 *   - where().update() 返回 { stats: { updated } }，用条件更新模拟 CAS
 *   - doc(id).set() 是「有则覆盖、无则创建」
 *   - _.inc(n) 是原子自增
 *
 * 有了它，账号全流程（注册→登录→改密→找回→登出→多设备同步）
 * 可以在几毫秒内跑完，不需要云环境、不需要联网、也不产生任何费用。
 */

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

class Store {
  constructor() {
    this.cols = new Map();
    this.autoId = 0;
  }

  collection(name) {
    if (!this.cols.has(name)) this.cols.set(name, new Map());
    return this.cols.get(name);
  }

  /** 直接读取整个集合（测试断言用） */
  dump(name) {
    return Array.from(this.collection(name).values()).map(clone);
  }

  /** 清空全部数据（模拟环境重置） */
  reset() {
    this.cols = new Map();
    this.autoId = 0;
  }

  nextId() {
    this.autoId++;
    return 'auto_' + this.autoId.toString(36).padStart(4, '0');
  }
}

const INC = '__mock_inc__';

function command() {
  return {
    inc(n) { return { [INC]: n }; },
    set(v) { return { __mock_set__: v }; },
    gt(v) { return { __mock_cmp__: 'gt', v }; },
    gte(v) { return { __mock_cmp__: 'gte', v }; },
    lt(v) { return { __mock_cmp__: 'lt', v }; },
    lte(v) { return { __mock_cmp__: 'lte', v }; },
    neq(v) { return { __mock_cmp__: 'neq', v }; }
  };
}

function isCmd(v) { return v && typeof v === 'object' && (INC in v || '__mock_cmp__' in v || '__mock_set__' in v); }

function matchOne(docVal, cond) {
  if (isCmd(cond)) {
    if (INC in cond || '__mock_set__' in cond) return false;
    const a = docVal;
    const b = cond.v;
    switch (cond.__mock_cmp__) {
      case 'gt': return a > b;
      case 'gte': return a >= b;
      case 'lt': return a < b;
      case 'lte': return a <= b;
      case 'neq': return a !== b;
      default: return false;
    }
  }
  return docVal === cond;
}

function match(doc, where) {
  const keys = Object.keys(where || {});
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (!matchOne(doc[k], where[k])) return false;
  }
  return true;
}

function applyPatch(doc, data) {
  Object.keys(data).forEach((k) => {
    const v = data[k];
    if (isCmd(v) && INC in v) doc[k] = (typeof doc[k] === 'number' ? doc[k] : 0) + v[INC];
    else if (isCmd(v) && '__mock_set__' in v) doc[k] = clone(v.__mock_set__);
    else doc[k] = clone(v);
  });
}

class Query {
  constructor(store, name, where) {
    this.store = store;
    this.name = name;
    this.where = where || {};
    this.limitN = 100;
  }

  limit(n) { this.limitN = n; return this; }

  orderBy() { return this; }

  async get() {
    const list = [];
    this.store.collection(this.name).forEach((doc) => {
      if (match(doc, this.where)) list.push(clone(doc));
    });
    return { data: list.slice(0, this.limitN), errMsg: 'collection.get:ok' };
  }

  async count() {
    let n = 0;
    this.store.collection(this.name).forEach((doc) => { if (match(doc, this.where)) n++; });
    return { total: n };
  }

  async update({ data }) {
    let updated = 0;
    this.store.collection(this.name).forEach((doc) => {
      if (!match(doc, this.where)) return;
      applyPatch(doc, data);
      updated++;
    });
    return { stats: { updated: updated }, errMsg: 'document.update:ok' };
  }

  async remove() {
    const col = this.store.collection(this.name);
    let removed = 0;
    Array.from(col.keys()).forEach((id) => {
      if (match(col.get(id), this.where)) { col.delete(id); removed++; }
    });
    return { stats: { removed: removed } };
  }
}

class DocRef {
  constructor(store, name, id) {
    this.store = store;
    this.name = name;
    this.id = id;
  }

  async get() {
    const doc = this.store.collection(this.name).get(this.id);
    if (!doc) {
      // 与云开发一致：不存在时 reject，调用方必须自己兜底
      const e = new Error('document.get:fail document not exists');
      e.errCode = -1;
      throw e;
    }
    return { data: clone(doc), errMsg: 'document.get:ok' };
  }

  async set({ data }) {
    const payload = Object.assign({}, clone(data), { _id: this.id });
    this.store.collection(this.name).set(this.id, payload);
    return { _id: this.id, errMsg: 'document.set:ok' };
  }

  async update({ data }) {
    const doc = this.store.collection(this.name).get(this.id);
    if (!doc) return { stats: { updated: 0 } };
    applyPatch(doc, data);
    return { stats: { updated: 1 }, errMsg: 'document.update:ok' };
  }

  async remove() {
    const col = this.store.collection(this.name);
    const had = col.has(this.id);
    col.delete(this.id);
    return { stats: { removed: had ? 1 : 0 } };
  }
}

class Collection {
  constructor(store, name) {
    this.store = store;
    this.name = name;
  }

  doc(id) { return new DocRef(this.store, this.name, id); }

  where(cond) { return new Query(this.store, this.name, cond); }

  orderBy() { return new Query(this.store, this.name, {}); }

  limit(n) { return new Query(this.store, this.name, {}).limit(n); }

  async get() { return new Query(this.store, this.name, {}).get(); }

  async add({ data }) {
    const id = (data && data._id) || this.store.nextId();
    const payload = Object.assign({}, clone(data), { _id: id });
    this.store.collection(this.name).set(id, payload);
    return { _id: id, errMsg: 'collection.add:ok' };
  }

  async count() { return new Query(this.store, this.name, {}).count(); }
}

export function createMockDb() {
  const store = new Store();
  return {
    collection(name) { return new Collection(store, name); },
    command: command(),
    // 测试专用
    __store: store,
    dump(name) { return store.dump(name); },
    reset() { store.reset(); }
  };
}

export { command };
