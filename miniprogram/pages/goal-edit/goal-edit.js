/**
 * 新建 / 编辑目标。
 *
 * 「有总量、有终点」是这个产品的立身之本，所以表单把「总量」和「截止日」
 * 放在最前，并在保存前就把「每天要做多少」算给用户看 ——
 * 让用户在动机最强的那一刻看到任务的真实体量，而不是建档之后才发现做不完。
 */

const store = require('../../utils/store.js');
const M = require('../../utils/model.js');
const U = require('../../utils/util.js');
const prefs = require('../../utils/prefs.js');

const COLORS = M.COLORS;

Page({
  data: {
    themeClass: '',
    id: '',
    isNew: true,
    form: { name: '', unit: '', total: '', deadline: '', color: COLORS[0], obstacle: '', plan: '' },
    /** date picker 可选下限：新建=今天，编辑=目标创建日。绝不绑 form.deadline ——
        那会把「只能选今天以后」变成「只能选当前值以后」，截止日就没法提前了 */
    minDate: '',
    colors: COLORS.map((c) => ({ hex: c, css: U.gcolor(c) })),
    errors: {},
    preview: null,
    dangerOpen: false,
    toast: '',
    toastOn: false
  },

  onLoad(query) {
    // 二级页有系统浅色导航栏，状态栏回到黑字
    prefs.setStatusBarLight(false);

    const st = store.get();
    this.setData({ themeClass: prefs.themeClassOf(st && st.settings && st.settings.theme) });
    const id = query && query.id ? decodeURIComponent(query.id) : '';
    if (!id) {
      // 默认截止日给 60 天后：太短会让人直接放弃，太长会让目标失去紧迫感
      const deadline = U.addDays(U.todayStr(), 60);
      this.setData({ form: Object.assign({}, this.data.form, { deadline: deadline }), minDate: U.todayStr() });
      this.updatePreview();
      return;
    }
    const g = M.goalById(store.get(), id);
    if (!g || g.deleted) {
      wx.showToast({ title: '目标不存在', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.setData({
      id: id,
      isNew: false,
      minDate: g.createdAt || U.todayStr(),
      form: {
        name: g.name,
        unit: g.unit,
        total: U.trimNum(g.total),
        deadline: g.deadline,
        color: COLORS.indexOf(g.color) >= 0 ? g.color : COLORS[0],
        obstacle: g.obstacle || '',
        plan: g.plan || ''
      }
    });
    this.updatePreview();
  },

  onInput(e) {
    const f = e.currentTarget.dataset.field;
    const patch = {};
    patch['form.' + f] = e.detail.value;
    if (this.data.errors[f]) {
      const errs = Object.assign({}, this.data.errors);
      errs[f] = '';
      patch.errors = errs;
    }
    this.setData(patch);
    this.updatePreview();
  },

  pickColor(e) {
    this.setData({ 'form.color': e.currentTarget.dataset.hex });
  },

  onDateChange(e) {
    this.setData({ 'form.deadline': e.detail.value });
    this.updatePreview();
  },

  /** 实时算出「每天需要推进多少」，让用户在建档时就感知到强度 */
  updatePreview() {
    const f = this.data.form;
    const total = Number(f.total);
    if (!isFinite(total) || total <= 0 || !U.isDateString(f.deadline)) {
      this.setData({ preview: null });
      return;
    }
    const today = U.todayStr();
    const days = U.diffDays(today, f.deadline);
    if (days < 0) {
      this.setData({ preview: { warn: true, text: '截止日已经过去了，请重新选一个日期' } });
      return;
    }
    const totalDays = Math.max(1, days + 1);
    const perDay = Math.ceil(total / totalDays);
    this.setData({
      preview: {
        warn: days < 3,
        text: '共 ' + totalDays + ' 天 · 平均每天 ' + perDay + ' ' + (f.unit || '个') + (days < 3 ? '（时间很紧）' : '')
      }
    });
  },

  validate() {
    const f = this.data.form;
    const errs = {};
    const name = String(f.name || '').trim();
    const unit = String(f.unit || '').trim();
    const total = Number(f.total);

    if (!name) errs.name = '请填写目标名称';
    else if (name.length > 30) errs.name = '名称最多 30 字';
    if (unit.length > 6) errs.unit = '单位最多 6 字';
    if (!f.total) errs.total = '请填写总量';
    else if (!isFinite(total) || total <= 0) errs.total = '总量要是大于 0 的数字';
    else if (total > 1e9) errs.total = '总量过大';
    if (!U.isDateString(f.deadline)) errs.deadline = '请选择截止日期';
    else if (f.deadline < U.todayStr() && this.data.isNew) errs.deadline = '截止日期不能早于今天';

    this.setData({ errors: errs });
    return Object.keys(errs).length === 0;
  },

  save() {
    if (!this.validate()) {
      const first = Object.keys(this.data.errors).filter((k) => this.data.errors[k])[0];
      const label = { name: '名称', unit: '单位', total: '总量', deadline: '截止日期' }[first] || '表单';
      this.toast(label + '还没填好');
      return;
    }
    const f = this.data.form;
    const payload = {
      name: String(f.name).trim(),
      unit: String(f.unit).trim() || '个',
      total: Number(f.total),
      deadline: f.deadline,
      color: f.color,
      obstacle: String(f.obstacle || '').trim(),
      plan: String(f.plan || '').trim()
    };

    if (this.data.isNew) {
      store.addGoal(Object.assign({ id: U.uid(), createdAt: U.todayStr(), sample: false }, payload));
    } else {
      store.updateGoal(this.data.id, payload);
    }

    wx.showToast({ title: '已保存', icon: 'success', duration: 1200 });
    setTimeout(() => wx.navigateBack(), 500);
  },

  toggleDanger() { this.setData({ dangerOpen: !this.data.dangerOpen }); },

  confirmDelete() {
    const st = store.get();
    const done = M.doneAmount(st, this.data.id);
    const count = st.logs.filter((l) => l.goalId === this.data.id && !l.deleted).length;
    wx.showModal({
      title: '删除这个目标？',
      content: '连同它的 ' + count + ' 条打卡记录（共 ' + U.trimNum(done) + '）一起删除，所有设备同步生效。',
      confirmText: '删除',
      confirmColor: '#FF3B30',
      success: (res) => {
        if (!res.confirm) return;
        store.deleteGoal(this.data.id);
        wx.showToast({ title: '已删除', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 400);
      }
    });
  },

  toast(msg) {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.setData({ toast: msg, toastOn: true });
    this.toastTimer = setTimeout(() => this.setData({ toastOn: false }), 1800);
  }
});
