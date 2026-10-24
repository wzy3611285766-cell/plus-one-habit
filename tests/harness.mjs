/**
 * 极简测试框架。
 *
 * 为什么不用 node:test：本机的 Node 是微信开发者工具内嵌的 Electron
 * （ELECTRON_RUN_AS_NODE=1 启动），它的 test runner 行为与原生 Node 不完全一致，
 * 依赖它会让「测试能不能跑」变成一个环境问题。自己写 60 行断言反而更可控：
 * 没有魔法，失败就退出码 1，能被任何 CI 接住。
 */

let passed = 0;
let failed = 0;
const failures = [];
let currentGroup = '';

export function group(name) {
  currentGroup = name;
  console.log('\n── ' + name + ' ' + '─'.repeat(Math.max(4, 56 - name.length)));
}

export async function test(name, fn) {
  const label = (currentGroup ? currentGroup + ' › ' : '') + name;
  try {
    await fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (e) {
    failed++;
    failures.push({ label, error: e });
    console.log('  FAIL  ' + name);
    console.log('        ' + String((e && e.message) || e).split('\n').join('\n        '));
  }
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

export function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg ? msg + '：' : '') + '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}

export function deepEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg ? msg + '：' : '') + '\n期望 ' + b + '\n实际 ' + a);
}

export function includes(haystack, needle, msg) {
  if (String(haystack).indexOf(needle) < 0) {
    throw new Error((msg ? msg + '：' : '') + '期望包含 ' + JSON.stringify(needle) + '，实际 ' + JSON.stringify(String(haystack).slice(0, 200)));
  }
}

/** 断言一个 async 操作抛出指定错误码 */
export async function rejectsWithCode(fn, code, msg) {
  try {
    await fn();
  } catch (e) {
    if (e && e.code === code) return e;
    throw new Error((msg ? msg + '：' : '') + '期望错误码 ' + code + '，实际 ' + (e && e.code) + ' / ' + (e && e.message));
  }
  throw new Error((msg ? msg + '：' : '') + '期望抛出 ' + code + '，但没有抛错');
}

/** 当前统计（供总入口汇总，不重置计数） */
export function counts() { return { passed, failed, failures }; }

export function summary(title) {
  console.log('\n' + '='.repeat(60));
  if (failed === 0) {
    console.log((title || '测试') + '：全部通过（' + passed + ' 项）');
  } else {
    console.log((title || '测试') + '：失败 ' + failed + ' 项 / 通过 ' + passed + ' 项');
    failures.forEach((f) => {
      console.log('  ✗ ' + f.label);
      console.log('    ' + String((f.error && f.error.stack) || f.error).split('\n').slice(0, 5).join('\n    '));
    });
  }
  console.log('='.repeat(60));
  return failed;
}
