/**
 * 共享内核一致性测试。
 *
 * 背景：微信云函数上传时只打包本函数目录，`require('../auth/lib/xxx')` 在线上必然失败，
 * 云开发也没有 Lambda Layer 那样的公共层机制。所以 errors.js
 * 在两个云函数里各放一份副本 —— 这是业界通行做法，但代价是副本可能悄悄漂移：
 * 比如修了 auth 侧的「未登录」错误码，却忘了同步 sync 侧，
 * 结果客户端收到一个不认识的 code 而无法跳登录，是最难查的一类线上问题。
 *
 * 这个测试就是那道防线：两份文件必须逐字节相同，否则直接失败。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, test, assert, eq } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const AUTH_LIB = path.join(ROOT, 'cloudfunctions', 'auth', 'lib');
const SYNC_LIB = path.join(ROOT, 'cloudfunctions', 'sync', 'lib');

/** 只有错误码是真正需要共享的：身份换算各写各的，但错误码必须一张表 */
const SHARED = ['errors.js'];

/** 去掉 BOM 与行尾差异后比较，避免 Git 的 CRLF 设置造成假失败 */
function normalize(p) {
  return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

group('共享内核一致性');

SHARED.forEach((file) => {
  test(file + ' 在 auth 与 sync 中必须完全一致', () => {
    const a = path.join(AUTH_LIB, file);
    const b = path.join(SYNC_LIB, file);
    assert(fs.existsSync(a), '缺少 ' + a);
    assert(fs.existsSync(b), '缺少 ' + b);
    const ca = normalize(a);
    const cb = normalize(b);
    if (ca !== cb) {
      // 指出第一处差异的行号，排障时不用手工 diff
      const la = ca.split('\n');
      const lb = cb.split('\n');
      let line = -1;
      for (let i = 0; i < Math.max(la.length, lb.length); i++) {
        if (la[i] !== lb[i]) { line = i + 1; break; }
      }
      throw new Error('两份副本不一致，首个差异在第 ' + line + ' 行\n'
        + '  auth: ' + JSON.stringify(la[line - 1]) + '\n'
        + '  sync: ' + JSON.stringify(lb[line - 1]) + '\n'
        + '  修改共享内核时必须同时更新两个云函数目录下的同名文件。');
    }
  });
});

/** 去掉注释再做依赖扫描：文件头部的说明文字里会出现「反例」路径，不能当成真实依赖 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('共享内核只依赖 Node 内置模块与自身，不会拖入云函数私有代码', () => {
  SHARED.forEach((file) => {
    const src = stripComments(normalize(path.join(AUTH_LIB, file)));
    const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    requires.forEach((dep) => {
      const isBuiltin = dep.indexOf('.') !== 0;
      const isSiblingShared = dep === './errors.js' && file !== 'errors.js';
      assert(isBuiltin || isSiblingShared,
        file + ' 依赖了 ' + dep + '，共享内核只能依赖 Node 内置模块与 errors.js');
    });
  });
});

test('auth 独有模块不会被 sync 误引用（sync 只应依赖共享内核与自己的代码）', () => {
  const files = fs.readdirSync(SYNC_LIB).filter((f) => f.endsWith('.js'));
  const allowed = ['errors.js', 'repo.js', 'shard.js', 'service.js'];
  files.forEach((f) => {
    assert(allowed.indexOf(f) >= 0, 'sync/lib 出现了未预期的文件：' + f);
  });
});

test('两个云函数都声明了 wx-server-sdk 依赖', () => {
  ['auth', 'sync'].forEach((fn) => {
    const p = path.join(ROOT, 'cloudfunctions', fn, 'package.json');
    assert(fs.existsSync(p), fn + ' 缺少 package.json');
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert(pkg.dependencies && pkg.dependencies['wx-server-sdk'], fn + ' 未声明 wx-server-sdk');
  });
});

export const suite = '共享内核一致性';
