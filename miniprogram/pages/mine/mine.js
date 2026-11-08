/**
 * 独立页入口。
 * 逻辑在 mine-logic.js —— 单页容器（pages/home）会直接复用那份配置，
 * 这里只负责注册成页面，保证旧的分享链接 / 路径仍然能打开。
 */
Page(require('./mine-logic.js'));
