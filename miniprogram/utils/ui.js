/**
 * 界面共享件：同步状态文案 + 删除目标确认弹窗。
 * 同一操作在多个页面只允许一种说法 —— 两份拷贝各自演化，迟早走样。
 */

const M = require('./model.js');
const U = require('./util.js');

const SYNC_LABELS = {
  idle: '待同步', syncing: '同步中', synced: '已同步',
  error: '同步失败', needlogin: '未登录', offline: '离线'
};

const SYNC_DOTS = {
  synced: 'ok', syncing: 'sync', error: 'err',
  needlogin: 'off', offline: 'off', idle: 'off'
};

function syncLabel(phase) { return SYNC_LABELS[phase] || '待同步'; }

function syncDot(phase) { return SYNC_DOTS[phase] || 'off'; }

/** 删除目标的两段确认：today 的「⋯」抽屉与 goal-edit 的删除区共用这一份文案 */
function confirmDeleteGoal(st, gid, onConfirm) {
  const g = M.goalById(st, gid);
  if (!g) return;
  const done = M.doneAmount(st, gid);
  const count = st.logs.filter((l) => l.goalId === gid && !l.deleted).length;
  wx.showModal({
    title: '删除这个目标？',
    content: '连同它的 ' + count + ' 条打卡记录（共 ' + U.trimNum(done) + '）一起删除，所有设备同步生效。',
    confirmText: '删除',
    confirmColor: '#FF3B30',
    success: (res) => { if (res.confirm) onConfirm(); }
  });
}

module.exports = {
  syncLabel: syncLabel,
  syncDot: syncDot,
  confirmDeleteGoal: confirmDeleteGoal
};
