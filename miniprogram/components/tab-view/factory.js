/**
 * 把一份「页面配置」适配成自定义组件。
 *
 * 单页容器（pages/home）要把四个 tab 塞进同一个页面，而四个页面的业务逻辑
 * 原本都是 Page({...})。与其把几千行逻辑重写一遍，不如在这里做一层薄适配：
 *
 *   onLoad / onReady / onUnload → lifetimes
 *   onShow / onHide             → pageLifetimes
 *   其余方法                    → methods
 *
 * 逻辑文件本身一行不改，独立页面入口（pages/today/today.js）也仍然用同一份，
 * 所以单页版和四页版可以随时对照、回退。
 */

module.exports = function makeView(logic) {
  const methods = {};
  Object.keys(logic).forEach((k) => {
    if (typeof logic[k] === 'function') methods[k] = logic[k];
  });

  /* 视图内切 tab：单页里没有 switchTab 可调，交给容器统一处理。
     独立页面里 this.__switchTab 不存在，逻辑里的 fallback 会自动走 switchTab。 */
  methods.__switchTab = function (key) {
    this.triggerEvent('switchtab', { key: key });
  };

  /* 容器切到本视图时手动触发一次显示。
     pageLifetimes.show 只在「页面」显示时触发，页面内部切视图不会触发它。 */
  methods.__show = function () {
    if (logic.onShow) logic.onShow.call(this);
  };
  methods.__hide = function () {
    if (logic.onHide) logic.onHide.call(this);
  };

  /* 「我的」页弹层要收起底栏、改主题要刷新底栏 —— 组件里没有 getTabBar()，
     统一抛给容器处理。 */
  methods.__setTabBarVisible = function (visible) {
    this.triggerEvent('tabbar', { visible: visible });
  };
  methods.__syncTabBarTheme = function () {
    this.triggerEvent('tabbartheme', {});
  };

  return {
    options: { styleIsolation: 'apply-shared' },
    data: JSON.parse(JSON.stringify(logic.data || {})),
    lifetimes: {
      attached() { if (logic.onLoad) logic.onLoad.call(this); },
      ready() { if (logic.onReady) logic.onReady.call(this); },
      detached() { if (logic.onUnload) logic.onUnload.call(this); }
    },
    pageLifetimes: {
      show() { if (logic.onShow) logic.onShow.call(this); },
      hide() { if (logic.onHide) logic.onHide.call(this); }
    },
    methods: methods
  };
};
