/**
 * 分享卡：把「今天完成了什么 + 我有哪些目标」画成一张 5:4 的图。
 *
 * 为什么不用当前页面截图：截图里是导航、tabBar、按钮，收卡片的人看不到重点；
 * 这张卡只回答两件事 —— 今天打了几个目标、我在追哪些目标。
 *
 * 分工：
 *   summarize(st)   纯数据，可在 Node 里测；
 *   draw(ctx, s)    只负责画（500×400 逻辑坐标），不碰 wx；
 *   titleOf / decorate / refresh  页面与组件之间的胶水。
 */

const M = require('./model.js');
const U = require('./util.js');

const W = 500;
const H = 400;

/* ---------------- 数据 ---------------- */

function summarize(st, today) {
  const state = st || { goals: [], logs: [] };
  const t = today || U.todayStr();
  // 只把「还在进行中」的目标放进分享卡；已完成的用 totalGoals 单独统计
  const goals = M.activeGoals(state).filter((g) => !M.isComplete(state, g));
  const todayLogs = M.activeLogs(state).filter((l) => l.date === t);
  const hit = goals.filter((g) => M.logsOn(state, g.id, t) > 0).length;
  const streak = M.globalStreak(state);
  const totalGoals = (state.goals || []).filter((g) => !g.deleted).length;

  const top = goals.slice(0, 3).map((g) => {
    const done = M.doneAmount(state, g.id);
    return {
      name: g.name,
      unit: g.unit || '个',
      done: done,
      total: g.total,
      pct: g.total > 0 ? Math.max(0, Math.min(100, done / g.total * 100)) : 0,
      today: M.logsOn(state, g.id, t),
      color: /^#[0-9a-fA-F]{6}$/.test(String(g.color || '')) ? g.color : '#6366f1'
    };
  });

  const allDone = goals.length > 0 && hit === goals.length;
  let headline;
  if (!goals.length) headline = totalGoals > 0 ? '所有目标都已达成' : '从第一个目标开始';
  else if (allDone) headline = '今天全部目标都打卡了';
  else if (hit > 0) headline = '今天完成 ' + hit + ' / ' + goals.length + ' 个目标';
  else headline = '今天还有 ' + goals.length + ' 个目标待打卡';

  const subParts = [];
  if (!goals.length && totalGoals > 0) subParts.push('共 ' + totalGoals + ' 个目标');
  else if (todayLogs.length) subParts.push('记录 ' + todayLogs.length + ' 次');
  else subParts.push('今天还没记录');
  if (streak > 0) subParts.push('连续 ' + streak + ' 天');
  if (goals.length) subParts.push('进行中 ' + goals.length + ' 个');

  let title;
  if (!goals.length) title = totalGoals > 0 ? '所有目标都达成了，来看看我的打卡' : '开始第一个目标，每天 +1';
  else if (allDone) title = '今天 ' + goals.length + ' 个目标全打卡了，连续 ' + streak + ' 天';
  else if (hit > 0) title = '今天完成 ' + hit + '/' + goals.length + ' 个目标，连续 ' + streak + ' 天';
  else title = '目标打卡中：' + goals.length + ' 个目标，今天从 1 开始';

  return {
    date: t,
    dateText: U.fmtShort(t),
    weekday: U.weekdayCN(t),
    goals: goals.length,
    totalGoals: totalGoals,
    hit: hit,
    todayLogs: todayLogs.length,
    streak: streak,
    allDone: allDone,
    top: top,
    more: Math.max(0, goals.length - top.length),
    headline: headline,
    sub: subParts.join(' · '),
    title: title
  };
}

function titleOf(st) {
  return summarize(st).title;
}

/* ---------------- 绘制 ---------------- */

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function fitText(ctx, str, maxWidth) {
  const s = String(str == null ? '' : str);
  if (ctx.measureText(s).width <= maxWidth) return s;
  let cut = s;
  while (cut.length > 0 && ctx.measureText(cut + '…').width > maxWidth) cut = cut.slice(0, -1);
  return cut + '…';
}

function draw(ctx, s) {
  const state = s || summarize(null);

  ctx.clearRect(0, 0, W, H);

  // 底：深蓝渐变，与首页 hero 同一套色
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0B2A5B');
  bg.addColorStop(0.55, '#0F3570');
  bg.addColorStop(1, '#123E7C');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 两团柔光，避免大块纯色
  ctx.fillStyle = 'rgba(99,102,241,.20)';
  ctx.beginPath(); ctx.arc(438, 34, 120, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(14,165,233,.10)';
  ctx.beginPath(); ctx.arc(40, 392, 110, 0, Math.PI * 2); ctx.fill();

  ctx.textBaseline = 'middle';

  // 顶栏：品牌 + 日期
  roundRect(ctx, 32, 28, 38, 38, 12);
  ctx.fillStyle = 'rgba(255,255,255,.14)';
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText('+1', 51, 48);

  ctx.textAlign = 'left';
  ctx.font = 'bold 17px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,.96)';
  ctx.fillText('PLus one habit', 82, 47);

  ctx.textAlign = 'right';
  ctx.font = '12px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,.62)';
  ctx.fillText(state.dateText + ' · ' + state.weekday, 468, 47);

  // 主标题
  ctx.textAlign = 'left';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText(fitText(ctx, state.headline, 436), 32, 118);

  // 副标题
  ctx.font = '13px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,.72)';
  ctx.fillText(fitText(ctx, state.sub, 436), 32, 149);

  // 目标行：前三个
  const startY = 190;
  const rowH = 54;
  ctx.textBaseline = 'middle';
  state.top.forEach((g, i) => {
    const y = startY + i * rowH;

    ctx.fillStyle = g.color;
    ctx.beginPath();
    ctx.arc(39, y, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,.94)';
    ctx.font = 'bold 16px sans-serif';
    const shownName = fitText(ctx, g.name, 230);
    ctx.fillText(shownName, 54, y);

    // 今天在这个目标上推进了多少：名字后面的小徽章
    if (g.today > 0) {
      const badge = '今天 +' + U.trimNum(g.today);
      const bx = 54 + ctx.measureText(shownName).width + 10;
      ctx.font = '10px sans-serif';
      const bw = ctx.measureText(badge).width + 12;
      if (bx + bw <= 300) {
        roundRect(ctx, bx, y - 9, bw, 18, 9);
        ctx.fillStyle = 'rgba(255,255,255,.16)';
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.88)';
        ctx.fillText(badge, bx + 6, y);
      }
    }

    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,.70)';
    ctx.font = '12px sans-serif';
    ctx.fillText(U.trimNum(g.done) + ' / ' + U.trimNum(g.total) + ' ' + g.unit, 468, y);

    // 进度条
    const bx = 39, bw = 429, by = y + 15, bh = 5;
    roundRect(ctx, bx, by, bw, bh, bh / 2);
    ctx.fillStyle = 'rgba(255,255,255,.16)';
    ctx.fill();

    const fw = Math.round(bw * (g.pct / 100) * 100) / 100;
    if (fw > 0) {
      roundRect(ctx, bx, by, Math.max(fw, bh), bh, bh / 2);
      ctx.fillStyle = g.color;
      ctx.fill();
    }
  });

  if (state.more > 0) {
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,.50)';
    ctx.font = '11px sans-serif';
    ctx.fillText('还有 ' + state.more + ' 个目标', 32, 348);
  }

  // 底栏
  ctx.strokeStyle = 'rgba(255,255,255,.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(32, 362);
  ctx.lineTo(468, 362);
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  ctx.font = '11px sans-serif';
  ctx.fillText('每天 +1 · 积累看得见', 32, 381);

  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,.80)';
  ctx.fillText('打开小程序一起打卡  →', 468, 381);
}

/* ---------------- 页面胶水 ---------------- */

/** 页面里找隐藏画布组件（测试环境没有 selectComponent，返回 null 即可） */
function cardOf(page) {
  if (!page || typeof page.selectComponent !== 'function') return null;
  try { return page.selectComponent('#shareCard'); } catch (e) { return null; }
}

/** 让当前页的分享卡按最新数据重画（页面 onShow / 打卡后调用） */
function refresh(page) {
  const card = cardOf(page);
  if (card && typeof card.refresh === 'function') card.refresh();
}

/**
 * 给 onShareAppMessage 的返回值补上标题和图片。
 * 卡片还没画好时只保留原配置（微信会退回默认图），绝不阻塞分享。
 */
function decorate(base, page) {
  const card = cardOf(page);
  if (!card) return base;
  try {
    const title = typeof card.title === 'function' ? card.title() : '';
    const image = typeof card.image === 'function' ? card.image() : '';
    if (title) base.title = title;
    if (image) base.imageUrl = image;
  } catch (e) { /* 分享不能因为画卡失败而失败 */ }
  return base;
}

module.exports = { W, H, summarize, titleOf, draw, refresh, decorate };
