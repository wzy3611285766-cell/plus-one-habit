import path from 'node:path';
import { createRequire } from 'node:module';
import { createMockDb } from './mock/db.mjs';
import { installWxEnv } from './mock/wx.mjs';

process.env.AUTH_DEV_MODE = '1';
const env = installWxEnv({ db: createMockDb(), openid: 'openid-probe' });
const req = createRequire(import.meta.url);
const STORE = path.resolve('miniprogram/utils/store.js');
const FORK = path.resolve('miniprogram/utils/fork.js');
req(STORE);
console.log('after installWxEnv + require(store): store cache entries =', Object.keys(req.cache).filter((k) => k.endsWith(path.sep + 'store.js')).length);
delete req.cache[req.resolve(STORE)];
delete req.cache[req.resolve(FORK)];
const s2 = req(STORE);
console.log('re-required after delete: entries =', Object.keys(req.cache).filter((k) => k.endsWith(path.sep + 'store.js')).length, 'same?', s2 === undefined);
