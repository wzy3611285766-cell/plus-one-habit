/**
 * sync 云函数的数据访问层（集合 sync_docs）。
 *
 * 文档形态：
 *   { _id, userId, key:'core'|'logs:YYYY-MM', rev, payload, deviceId, createdAt, updatedAt }
 *
 * _id 由 userId + key 推导（sha1 截断），带来两个直接好处：
 *   - 同一个用户同一个分片永远落在同一条文档上，不需要「先查再写」；
 *   - 校验和更新都是按 _id 精确定位，天然防越权（拿不到别人的 _id 就改不了）。
 *
 * rev 是单调自增整数（不用时间戳）：设备时钟不准，时间戳做并发检测会漏判。
 */

const crypto = require('crypto');

const COL = {
  DOCS: 'sync_docs',
  // accounts 由云函数 auth 负责写入。sync 只读它，用来把 openid 换算成账号 ——
  // 这是「同步接口也必须确认身份」的前提。
  ACCOUNTS: 'accounts'
};

function docId(userId, key) {
  return 'd_' + crypto.createHash('sha1').update(String(userId) + '|' + String(key)).digest('hex').slice(0, 40);
}

function repo(db) {
  const _ = db.command;
  const col = () => db.collection(COL.DOCS);

  /** 通用单条读取：不存在时云开发会 reject，这里统一成 null */
  function getOne(name, id) {
    return db.collection(name).doc(id).get()
      .then((r) => (r && r.data) || null)
      .catch(() => null);
  }

  function find(name, where, limit) {
    return db.collection(name).where(where).limit(limit || 20).get()
      .then((r) => (r && r.data) || [])
      .catch(() => []);
  }

  function update(name, id, patch) {
    return db.collection(name).doc(id).update({ data: patch })
      .then((r) => (r && r.stats && r.stats.updated) || 0)
      .catch(() => 0);
  }

  return {
    COL: COL,

    /* ---------- 账号（身份换算） ---------- */

    findAccountByOpenid(openid) {
      if (!openid) return Promise.resolve(null);
      return find(COL.ACCOUNTS, { openid: openid }, 1).then((rows) => rows[0] || null);
    },

    getAccount(id) { return getOne(COL.ACCOUNTS, id); },

    /* ---------- 同步分片 ---------- */

    getDoc(id) {
      return col().doc(id).get()
        .then((r) => (r && r.data) || null)
        .catch(() => null);
    },

    createDoc(id, doc) {
      const payload = Object.assign({}, doc);
      delete payload._id;
      return col().doc(id).set({ data: payload }).then(() => id);
    },

    /**
     * 乐观并发更新：只有当文档当前 rev 仍等于 baseRev 时才写入。
     * 用 where + update 而不是 doc().update()，因为前者是原子的条件更新，
     * 两台设备同时推送时只有一台会成功，另一台拿到 stats.updated = 0 → 走冲突分支。
     */
    casUpdate(id, baseRev, patch) {
      return col().where({ _id: id, rev: baseRev }).update({ data: patch })
        .then((r) => (r && r.stats && r.stats.updated) || 0)
        .catch(() => 0);
    },

    listDocs(userId, limit) {
      return col().where({ userId: userId }).limit(limit || 200).get()
        .then((r) => (r && r.data) || [])
        .catch(() => []);
    },

    async deleteDocs(userId) {
      const rows = await this.listDocs(userId, 200);
      await Promise.all(rows.map((d) => col().doc(d._id).remove().catch(() => null)));
      return rows.length;
    }
  };
}

module.exports = { repo: repo, docId: docId, COL: COL };
