/**
 * prefetch 云函数的数据访问层（只读）。
 *
 * 与 sync/lib/repo.js 的差别：这里不写库、不做 CAS，只做两次查询：
 *   1. openid → accounts（换出 userId）
 *   2. userId → sync_docs（取该账号的全部分片）
 *
 * 为什么要复制一份而不是 require ../../sync/lib/repo.js：
 * 云函数是按目录独立打包部署的，跨目录 require 在线上不存在那些文件。
 * 项目里已有两处同类副本（errors.js），并由 shared-kernel 测试盯一致性。
 */

const COL = {
  ACCOUNTS: 'accounts',
  DOCS: 'sync_docs'
};

function repo(db) {
  function find(name, where, limit) {
    return db.collection(name).where(where).limit(limit || 1).get()
      .then((r) => (r && r.data) || [])
      .catch(() => []);
  }

  return {
    COL: COL,

    findAccountByOpenid(openid) {
      if (!openid) return Promise.resolve(null);
      return find(COL.ACCOUNTS, { openid: openid }, 1).then((rows) => rows[0] || null);
    },

    /** 分片数量很小（1 个 core + 最多 36 个月），一次取回比翻页简单 */
    listDocs(userId) {
      if (!userId) return Promise.resolve([]);
      return db.collection(COL.DOCS).where({ userId: userId }).limit(200).get()
        .then((r) => (r && r.data) || [])
        .catch(() => []);
    }
  };
}

module.exports = { repo: repo, COL: COL };
