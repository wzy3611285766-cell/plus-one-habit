/**
 * 测试总入口。
 *
 * 依次导入各测试套件（每个套件在导入时就执行其中的用例），最后统一汇总。
 * 用动态 import 而不是静态 import，是为了让某个套件导入失败时
 * 仍能给出「是哪个套件加载失败」而不是整片堆栈。
 */

import * as H from './harness.mjs';

const SUITES = [
  ['账号系统（注册/登录/会话/改密/找回/设备管理）', './auth.test.mjs'],
  ['打卡数据同步（分片/增量/冲突收敛/隔离）', './sync.test.mjs'],
  ['客户端数据模型（统计口径/合并算法）', './model.test.mjs'],
  ['页面纵向集成（页面→云函数→数据库）', './pages.test.mjs'],
  ['音效层（百分比增益/开关边界/实例复用）', './sfx.test.mjs'],
  ['共享内核一致性（auth 与 sync 的副本比对）', './shared-kernel.test.mjs'],
  ['小程序静态检查（WXML/WXSS/JSON/JS 语法）', './static.test.mjs']
];

console.log('学习目标管理台 · 小程序测试');
console.log('运行时 ' + process.version + '（Electron-as-Node ' + (process.versions.electron || '-') + '）');

let loadFailed = 0;
for (const [title, file] of SUITES) {
  try {
    await import(file);
  } catch (e) {
    loadFailed++;
    console.log('\n!! 套件加载失败：' + title);
    console.log(String((e && e.stack) || e).split('\n').slice(0, 8).join('\n'));
  }
}

const c = H.counts();
const totalFailed = c.failed + loadFailed;
console.log('\n' + '='.repeat(64));
if (totalFailed === 0) {
  console.log('全部通过 · ' + c.passed + ' 项断言通过，' + SUITES.length + ' 个套件');
} else {
  console.log('失败 ' + totalFailed + ' 项（通过 ' + c.passed + ' 项）');
  c.failures.forEach((f) => {
    console.log('\n  ✗ ' + f.label);
    console.log('    ' + String((f.error && f.error.stack) || f.error).split('\n').slice(0, 6).join('\n    '));
  });
}
console.log('='.repeat(64));
process.exit(totalFailed === 0 ? 0 : 1);
