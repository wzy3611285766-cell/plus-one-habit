/**
 * 本周小结（自动生成）。
 *
 * 为什么要有它：复盘的门槛不在「看结论」，而在「从四栏空白开始写」。
 * 用户点开周报，第一眼应该是「这周到底发生了什么」，而不是一张要填的表。
 * 手写区仍然保留，但降级成「想补充再展开」——不是必经流程。
 *
 * 生成原则（也是四条不能破的底线）：
 *   1. 只说数据里有的东西：次数、天数、连续、同期对比。不编造感受，不喊口号；
 *   2. 最多给一条建议，而且落在具体目标上（「给 X 排个固定时段」），
 *      不写「继续加油」这种放之四海皆准的句子；
 *   3. 本周没过完时用「上周同期」对比。否则周一打开就是
 *      「比上周少 8 次」，用户被自己的周报打击一次，下次就不点进来了；
 *   4. 空周不硬凑洞察，直接告诉他怎么开始。
 *
 * 纯函数：不碰 wx，方便单测（见 tests/weekly.test.mjs）。
 */

const M = require('./model.js');
const U = require('./util.js');

const WEEKEND_FROM = 5;   // 周一为 0：周六索引 5、周日索引 6

/** 一周内最长的连续打卡天数（休息日也算不断，与 model.streak 的口径一致） */
function maxRun(st, gid, dates, start) {
  let best = 0;
  let run = 0;
  for (let i = 0; i < 7; i++) {
    const d = U.addDays(start, i);
    if (dates[d]) { run++; if (run > best) best = run; continue; }
    if (M.isRestDay(st, gid, d, dates)) continue;   // 抵扣掉的漏打不打断连续
    run = 0;
  }
  return best;
}

/** 把一段区间的记录按目标聚合成 { days, sum, run } */
function collect(st, goals, start, end) {
  const per = {};
  const dates = {};
  goals.forEach((g) => { per[g.id] = { days: 0, sum: 0, run: 0 }; dates[g.id] = {}; });

  st.logs.forEach((l) => {
    if (l.deleted || !l.date || l.date < start || l.date > end) return;
    const p = per[l.goalId];
    if (!p) return;
    p.sum += l.amount || 0;
    if (!dates[l.goalId][l.date]) {
      dates[l.goalId][l.date] = 1;
      p.days++;
    }
  });

  goals.forEach((g) => { per[g.id].run = maxRun(st, g.id, dates[g.id], start); });
  return per;
}

/**
 * @param {object} st   store 的 state
 * @param {string} start 该周周一 YYYY-MM-DD
 * @param {string} end   该周周日 YYYY-MM-DD
 * @param {string} today 今天 YYYY-MM-DD
 * @returns {{tone:string, headline:string, lines:Array, remaining:number}}
 *   tone      good / watch / flat / empty，只用于给卡片左侧竖条上色
 *   remaining 本周还剩几天；往期周返回 -1
 */
function build(st, start, end, today) {
  const isCurrent = today >= start && today <= end;
  const elapsed = isCurrent ? Math.max(1, Math.min(7, U.diffDays(start, today) + 1)) : 7;
  const remaining = isCurrent ? 7 - elapsed : -1;

  /* 本周全部记录（含已完成目标）：与汇总卡的「N 次」口径保持一致 */
  let count = 0;
  const daySet = {};
  st.logs.forEach((l) => {
    if (l.deleted || !l.date) return;
    if (l.date < start || l.date > end) return;
    count++;
    daySet[l.date] = 1;
  });

  if (count === 0) {
    /* 全部在暂停中：这时候说「这周还没有打卡记录」像在追责，
       更准确的说法是「本来就没要求你打卡」。 */
    const live = M.activeGoals(st).filter((g) => !M.isComplete(st, g));
    if (live.length > 0 && live.every((g) => M.isPaused(g))) {
      return {
        tone: 'flat',
        headline: isCurrent ? '目标都在暂停中，这周没有打卡要求' : '那一周的目标都在暂停中',
        lines: [{
          k: 'paused',
          kind: 'try',
          label: '暂停',
          text: '暂停期不计入打卡统计，恢复后周报会接着往下写。'
        }],
        remaining: remaining
      };
    }
    return {
      tone: 'empty',
      headline: isCurrent ? '这周还没有打卡记录' : '那一周没有打卡记录',
      lines: [{
        k: 'start',
        kind: 'try',
        label: '开始',
        text: isCurrent
          ? '在「今日打卡」里点一次 +1 就算开始，周报会自己长出来。'
          : '空周也是一种信息：翻到本周，重新开始就行。'
      }],
      remaining: remaining
    };
  }

  /* 上周同期：同样的天数，而不是整周 —— 见文件头的第 3 条 */
  const prevStart = U.addDays(start, -7);
  const prevEnd = U.addDays(prevStart, elapsed - 1);
  let prevCount = 0;
  st.logs.forEach((l) => {
    if (l.deleted || !l.date) return;
    if (l.date >= prevStart && l.date <= prevEnd) prevCount++;
  });

  /* 只拿未完成、没在暂停的目标来评价：
     已完成的目标再提醒「保持」没有意义；暂停中的目标今天本来就不要求打卡，
     这时候点它的名（「这周还没动过」）是在催一件用户已经明确放下的事。 */
  const goals = M.activeGoals(st).filter((g) => !M.isComplete(st, g) && !M.isPaused(g));
  const per = collect(st, goals, start, end);
  const prevPer = collect(st, goals, prevStart, prevEnd);

  /* ---------- 一句话总结 ----------
     只留四个成分：这周几天 / PLus one 几次 / 活跃几天 / 比上周同期怎样。
     用户要判断的只有这四个数字，多一个字都是噪音。 */
  const head = [];
  head.push((isCurrent ? '这周 ' : '那周 ') + elapsed + ' 天');
  head.push('PLus one ' + count + ' 次');
  head.push('活跃 ' + Object.keys(daySet).length + ' 天');

  const diff = count - prevCount;
  let tone = 'flat';
  if (prevCount > 0) {
    if (diff > 0) { head.push('比上周同期多 ' + diff + ' 次'); tone = 'good'; }
    else if (diff < 0) { head.push('比上周同期少 ' + (-diff) + ' 次'); tone = 'watch'; }
    else head.push('比上周同期持平');
  } else {
    head.push('上周同期还没有记录');
    tone = count >= elapsed ? 'good' : 'flat';
  }

  /* ---------- 三条观察：最稳的一项 / 掉队的一项 / 下一步 ---------- */
  const lines = [];
  const ranked = goals
    .map((g) => ({
      g: g,
      p: per[g.id] || { days: 0, sum: 0, run: 0 },
      q: prevPer[g.id] || { days: 0 },
      /* 本周暂停过的目标：投入少是用户自己按的暂停，不是掉队。
         不参与「注意」判定，免得周报把一次主动休息说成失职。 */
      rested: M.pausedDaysBetween(g, start, end) > 0
    }))
    .sort((a, b) => (b.p.days - a.p.days) || (b.p.sum - a.p.sum));

  const steady = ranked.filter((x) => x.p.days > 0)[0];
  if (steady) {
    lines.push({
      k: 'keep',
      kind: 'keep',
      label: '保持',
      text: steady.p.run >= 3
        ? '「' + steady.g.name + '」连续 ' + steady.p.run + ' 天没断，是这周最稳的一项。'
        : '「' + steady.g.name + '」这周打了 ' + steady.p.days + ' 天，是投入最多的一项。'
    });
  }

  /* 掉队：上周同期至少 2 天，这周反而更少。只挑落差最大的一个，多说了像训人 */
  const slipped = ranked
    .filter((x) => !x.rested && x.q.days >= 2 && x.p.days < x.q.days)
    .sort((a, b) => (b.q.days - b.p.days) - (a.q.days - a.p.days))[0];

  /* 一次都没动过的目标：新目标也算 —— 刚建就忘了，更需要被看见 */
  const idle = ranked.filter((x) => !x.rested && x.p.days === 0)[0];

  if (slipped) {
    lines.push({
      k: 'slip', kind: 'watch', label: '注意',
      text: '「' + slipped.g.name + '」这周 ' + slipped.p.days + ' 天，上周同期 ' + slipped.q.days + ' 天。'
    });
  } else if (idle) {
    lines.push({
      k: 'idle', kind: 'watch', label: '注意',
      text: '「' + idle.g.name + '」这周还没动过。'
    });
  }

  if (isCurrent) {
    if (slipped) {
      lines.push({
        k: 'try', kind: 'try', label: '下周',
        text: '先给「' + slipped.g.name + '」排一个固定时段，比加新目标有用。'
      });
    } else if (idle) {
      lines.push({
        k: 'try', kind: 'try', label: '下周',
        text: '给「' + idle.g.name + '」定一个具体时间点，别只写在目标里。'
      });
    } else {
      /* 没有掉队的，就推一把离完成最近的目标 —— 这时候「快到了」比「继续」有信息量 */
      let near = null;
      goals.forEach((g) => {
        if (!(g.total > 0)) return;
        const done = M.doneAmount(st, g.id);
        const pct = Math.round(Math.min(100, done / g.total * 100));
        if (pct < 60) return;
        if (!near || pct > near.pct) near = { g: g, pct: pct, left: Math.max(1, Math.ceil(g.total - done)) };
      });

      if (near) {
        lines.push({
          k: 'try', kind: 'try', label: '下周',
          text: '「' + near.g.name + '」累计 ' + near.pct + '%，再推 ' + near.left + ' ' + near.g.unit + ' 就收尾。'
        });
      } else if (!daySet[U.addDays(start, WEEKEND_FROM)] && !daySet[U.addDays(start, WEEKEND_FROM + 1)]) {
        lines.push({
          k: 'try', kind: 'try', label: '下周',
          text: '周六日还没有记录，下周挑一天补上就够。'
        });
      } else {
        lines.push({
          k: 'try', kind: 'try', label: '下周',
          text: '节奏是稳的，别急着加新目标，先把这周的时间点固定下来。'
        });
      }
    }
  }

  return {
    tone: tone,
    headline: head.join('，') + '。',
    lines: lines.slice(0, 3),
    remaining: remaining
  };
}

module.exports = { build: build, maxRun: maxRun, collect: collect };
