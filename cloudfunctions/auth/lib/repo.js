/**
 * 数据访问层：账号。
 *
 * 只用云开发数据库 API 的一个很小子集，好处有两个：
 *   1. 单元测试里可以用一个百来行的内存实现替换掉，不必连真库；
 *   2. 业务逻辑（service.js）完全不接触 db 细节，读起来是纯粹的流程。
 *
 * 需要手工创建的索引见 README（唯一索引必须去控制台建，SDK 建不了）：
 *   accounts  openid(唯一)
 *
 * 只有这一个集合、这一个索引 —— 身份就是 openid，没有「用不到的字段」，
 * 所以也不再需要以前那套 na: 占位值来骗过唯一索引。
 */

const COL = {
  ACCOUNTS: 'accounts',
  /* 同步数据分片。日常读写由云函数 sync 负责，这里只在「注销账号」时
     把该账号的分片一起删掉 —— 账号没了、数据还留着，是最不该出现的数据残留。 */
  DOCS: 'sync_docs'
};

function repo(db) {
  function col(name) { return db.collection(name); }

  /** 单条读取，不存在时返回 null（云开发在不存在时会 reject，这里统一掉） */
  function getOne(name, id) {
    return col(name).doc(id).get()
      .then((r) => (r && r.data) || null)
      .catch(() => null);
  }

  /** 条件查询，最多取 limit 条 */
  function find(name, where, limit) {
    return col(name).where(where).limit(limit || 20).get()
      .then((r) => (r && r.data) || [])
      .catch(() => []);
  }

  function findOne(name, where) {
    return find(name, where, 1).then((rows) => rows[0] || null);
  }

  async function add(name, data) {
    const r = await col(name).add({ data: data });
    return (r && (r._id || (r.id))) || (data._id || null);
  }

  function update(name, id, patch) {
    return col(name).doc(id).update({ data: patch }).then((r) => (r && r.stats && r.stats.updated) || 0);
  }

  function remove(name, id) {
    return col(name).doc(id).remove().then(() => true).catch(() => false);
  }

  return {
    COL: COL,
    getOne: getOne,
    find: find,
    findOne: findOne,
    add: add,
    update: update,

    /* ---------- 账号 ---------- */

    findAccountByOpenid(openid) {
      if (!openid) return Promise.resolve(null);
      return findOne(COL.ACCOUNTS, { openid: openid });
    },

    getAccount(id) { return getOne(COL.ACCOUNTS, id); },

    createAccount(doc) { return add(COL.ACCOUNTS, doc); },

    updateAccount(id, patch) {
      return update(COL.ACCOUNTS, id, Object.assign({ updatedAt: Date.now() }, patch));
    },

    removeAccount(id) { return remove(COL.ACCOUNTS, id); },

    /** 删掉某账号的全部同步分片，返回删掉的条数 */
    async deleteSyncDocs(userId) {
      const rows = await find(COL.DOCS, { userId: userId }, 200);
      await Promise.all(rows.map((r) => remove(COL.DOCS, r._id)));
      return rows.length;
    }
  };
}

module.exports = { repo: repo, COL: COL };
