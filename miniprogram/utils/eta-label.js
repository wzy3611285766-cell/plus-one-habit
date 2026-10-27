/**
 * 「预计完成日」的展示文案。
 *
 * 计算在 model.eta 里：剩量 ÷ 平均速度。这里只决定怎么说人话：
 *   - 跨年的日期补上年份（2030-02-06 不能只写「2月6日」）；
 *   - 拖后超过一年就不再报具体天数 —— 从几天样本外推三年没有参考价值，
 *     直接说「按目前速度，截止前完不成」，比「拖后 1131 天」有用。
 */

const U = require('./util.js');

const FAR_BEHIND_DAYS = 365;

function dateText(dateStr, today) {
  const y = String(dateStr || '').slice(0, 4);
  const ty = String(today || U.todayStr()).slice(0, 4);
  return y === ty ? U.fmtShort(dateStr) : y + '年' + U.fmtShort(dateStr);
}

/** 仅处理 status=ok；done / unknown / overdue 由页面各自的文案负责 */
function label(e, today) {
  if (!e || e.status !== 'ok' || !e.date) return '';
  if (e.diff >= 0) return dateText(e.date, today) + ' · 提前 ' + e.diff + ' 天';
  if (-e.diff >= FAR_BEHIND_DAYS) return '按目前速度，截止前完不成';
  return dateText(e.date, today) + ' · 拖后 ' + (-e.diff) + ' 天';
}

module.exports = { FAR_BEHIND_DAYS, dateText, label };
