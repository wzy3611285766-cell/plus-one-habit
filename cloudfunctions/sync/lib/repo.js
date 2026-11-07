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

    /**
     * 新建分片文档。
     *
     * 必须用 add 而不是 doc().set()：set 是「有则覆盖」，两台设备同时首推
     * 同一个分片（例如刚在两边登录）时，后写的那份会静默盖掉先写的，
     * 双方都收到成功，谁也发现不了 —— pull 按 rev 比较，rev 都是 1，不会回传。
     * add 在 _id 已存在时会失败，调用方据此回读权威数据并走冲突分支。
     */
    createDoc(id, doc) {
      const payload = Object.assign({}, doc, { _id: id });
      return col().add({ data: payload }).then((r) => (r && (r._id || r.id)) || id);
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

    /**
     * 删除某账号的全部分片（清空云端数据用）。
     * 分页 + 串行，理由同 auth 的 deleteSyncDocs：一次只取 200 条会留残留，
     * 200 个并发 remove 可能被云开发限流。
     */
    async deleteDocs(userId) {
      const BATCH = 50;
      let removed = 0;
      for (;;) {
        const rows = await col().where({ userId: userId }).limit(BATCH).get()
          .then((r) => (r && r.data) || [])
          .catch(() => []);
        if (!rows.length) break;
        let okInBatch = 0;
        for (let i = 0; i < rows.length; i++) {
          const ok = await col().doc(rows[i]._id).remove().then(() => true).catch(() => false);
          if (ok) { removed++; okInBatch++; }
        }
        if (rows.length < BATCH || okInBatch === 0) break;
      }
      return removed;
    }
  };
}

module.exports = { repo: repo, docId: docId, COL: COL };
