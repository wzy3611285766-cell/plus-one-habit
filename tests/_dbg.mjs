import path from 'node:path';
import { createRequire } from 'node:module';
import { createMockDb } from './mock/db.mjs';
import { installWxEnv, loadPage, instantiate } from './mock/wx.mjs';

process.env.AUTH_DEV_MODE = '1';
const require = createRequire(import.meta.url);
const env = installWxEnv({ db: createMockDb(), openid: 'openid-dbg' });
const CFG = require('./../miniprogram/utils/config.js');
const fork = require('./../miniprogram/utils/fork.js');
const store = require('./../miniprogram/utils/store.js');

env.storage.clear();
store.load();
const g = { id:'g-1', name:'背单词', unit:'个', total:100, deadline:'2026-12-31', createdAt:'2026-10-01', color:'#6366f1', obstacle:'', plan:'', sample:false, deleted:false, updatedAt:1 };
const enc = fork.encodeTpl(fork.tplFromState({ goals:[g], logs:[] }));
console.log('enc len', enc.length);
console.log('apply:', JSON.stringify(store.applyShareQuery({ fr: enc }, false)));
console.log('pending:', store.forkWelcomePending(), 'record:', JSON.stringify(env.storage.get(CFG.K.FORK)));

const page = instantiate(loadPage(path.resolve('miniprogram/pages/today/today.js')));
page.onLoad();
page.render();
console.log('forkBanner:', page.data.forkBanner);
console.log('goals in page rows:', JSON.stringify((page.data.rows||[]).map(r=>r.name)));
