/**
 * 小程序静态检查。
 *
 * 这一层不跑业务逻辑，只保证「工程本身是自洽的」—— 很多低级问题
 * （页面注册了但文件缺失、WXML 少一个闭合标签、JSON 多一个逗号、
 * 误引外部 CDN）在微信开发者工具里只会给一句含糊的报错，
 * 在这里则能精确定位到文件和行。
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { group, test, assert, eq } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const MP = path.join(ROOT, 'miniprogram');
const CF = path.join(ROOT, 'cloudfunctions');

function walk(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  });
  return out;
}

function read(p) { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); }

/** 去掉 CSS 注释再做规则匹配：注释里会出现「反例」写法，不能当成真实声明 */
function stripCssComments(src) { return src.replace(/\/\*[\s\S]*?\*\//g, ''); }

function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }

const MP_FILES = walk(MP);
const CF_FILES = walk(CF);

const mp = (ext) => MP_FILES.filter((f) => path.extname(f) === ext);
const cf = (ext) => CF_FILES.filter((f) => path.extname(f) === ext);

/* ================================================================= */

group('JavaScript 语法');

test('小程序端全部 JS 文件语法正确', () => {
  const files = mp('.js');
  assert(files.length >= 10, '小程序端 JS 文件数量偏少，实际 ' + files.length);
  files.forEach((f) => {
    try {
      new vm.Script(read(f), { filename: rel(f) });
    } catch (e) {
      throw new Error(rel(f) + ' 语法错误：' + e.message);
    }
  });
});

test('云函数全部 JS 文件语法正确', () => {
  const files = cf('.js');
  assert(files.length >= 8, '云函数 JS 文件数量偏少，实际 ' + files.length);
  files.forEach((f) => {
    try {
      new vm.Script(read(f), { filename: rel(f) });
    } catch (e) {
      throw new Error(rel(f) + ' 语法错误：' + e.message);
    }
  });
});

test('测试脚本自身语法正确（ESM 解析，避免注释里的块注释提前闭合这类陷阱）', async () => {
  const files = fs.readdirSync(HERE).filter((f) => f.endsWith('.mjs'));
  assert(files.length >= 5, '测试脚本数量偏少，实际 ' + files.length);
  for (const f of files) {
    // 用真实的 import 让 ESM 解析器过一遍；解析失败会在 catch 里带上文件名
    try {
      await import('./' + f);
    } catch (e) {
      if (e && e.name === 'SyntaxError') throw new Error(f + ' 存在语法错误：' + e.message);
      // 其它异常（比如套件里 process.exit）不算语法问题，忽略
    }
  }
});

test('云函数源码里不出现 ES Module 语法（云函数按 CommonJS 运行）', () => {
  cf('.js').forEach((f) => {
    const src = read(f);
    assert(!/^\s*import\s+[\w{*]/m.test(src), rel(f) + ' 使用了 import 语句');
    assert(!/^\s*export\s+(default|const|function)/m.test(src), rel(f) + ' 使用了 export 语句');
  });
});

test('小程序端不使用服务端才有的 Node API', () => {
  const banned = ['require(\'crypto\')', 'require("crypto")', 'process.env', 'Buffer.from'];
  mp('.js').forEach((f) => {
    const src = read(f);
    banned.forEach((b) => {
      assert(src.indexOf(b) < 0, rel(f) + ' 使用了小程序环境不支持的 ' + b);
    });
  });
});

/* ================================================================= */

group('JSON 配置');

test('全部 JSON 文件格式正确', () => {
  const files = MP_FILES.concat(CF_FILES).filter((f) => path.extname(f) === '.json').concat([path.join(ROOT, 'project.config.json')]);
  files.forEach((f) => {
    try {
      JSON.parse(read(f));
    } catch (e) {
      throw new Error(rel(f) + ' JSON 解析失败：' + e.message);
    }
  });
});

const appJson = JSON.parse(read(path.join(MP, 'app.json')));

test('app.json 的每个页面都有完整的四件套文件', () => {
  assert(Array.isArray(appJson.pages) && appJson.pages.length >= 6, '页面数量异常');
  appJson.pages.forEach((p) => {
    ['.js', '.json', '.wxml', '.wxss'].forEach((ext) => {
      const f = path.join(MP, p + ext);
      assert(fs.existsSync(f), '缺少页面文件：' + p + ext);
    });
  });
});

test('tabBar 页面都在 pages 里注册，且第一个是默认首页', () => {
  const list = appJson.tabBar.list.map((t) => t.pagePath);
  eq(list.length, 4, '应有 4 个页签');
  list.forEach((p) => {
    assert(appJson.pages.indexOf(p) >= 0, 'tabBar 页 ' + p + ' 未在 pages 中注册');
  });
  eq(appJson.pages[0], list[0], '首页应与第一个页签一致');
});

test('使用自定义 tabBar 时不依赖任何位图图标', () => {
  eq(appJson.tabBar.custom, true);
  appJson.tabBar.list.forEach((t) => {
    eq(t.iconPath, undefined, t.text + ' 不应声明 iconPath（本项目不引位图资源）');
  });
  assert(fs.existsSync(path.join(MP, 'custom-tab-bar', 'index.js')), '缺少 custom-tab-bar/index.js');
  assert(fs.existsSync(path.join(MP, 'custom-tab-bar', 'index.wxml')), '缺少 custom-tab-bar/index.wxml');
  assert(fs.existsSync(path.join(MP, 'custom-tab-bar', 'index.wxss')), '缺少 custom-tab-bar/index.wxss');
});

test('深色模式配置齐全', () => {
  eq(appJson.darkmode, true);
  eq(appJson.themeLocation, 'theme.json');
  const theme = JSON.parse(read(path.join(MP, 'theme.json')));
  assert(theme.light && theme.dark, 'theme.json 必须同时提供 light 与 dark 两套');
});

test('project.config.json 指向正确的目录', () => {
  const cfg = JSON.parse(read(path.join(ROOT, 'project.config.json')));
  eq(cfg.miniprogramRoot, 'miniprogram/');
  eq(cfg.cloudfunctionRoot, 'cloudfunctions/');
  assert(cfg.projectname, '应声明项目名');
});

/* ================================================================= */

group('WXML');

test('WXML 标签正确闭合', () => {
  mp('.wxml').forEach((f) => {
    const src = read(f);
    const stack = [];
    const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
    let m;
    while ((m = re.exec(src))) {
      const closing = m[1] === '/';
      const tag = m[2];
      const selfClose = m[4] === '/';
      if (closing) {
        const top = stack.pop();
        if (top !== tag) {
          throw new Error(rel(f) + ' 标签未正确闭合：期望 </' + top + '>，实际 </' + tag + '>');
        }
      } else if (!selfClose) {
        stack.push(tag);
      }
    }
    if (stack.length) {
      throw new Error(rel(f) + ' 有未闭合的标签：' + stack.join(' > '));
    }
  });
});

test('WXML 不出现内联事件写法（小程序不支持 onclick）', () => {
  mp('.wxml').forEach((f) => {
    const src = read(f);
    assert(!/\son(click|change|input|load|error)\s*=/i.test(src), rel(f) + ' 使用了 HTML 的内联事件属性，小程序应用 bindtap 等');
    assert(src.indexOf('<script') < 0, rel(f) + ' 不应包含 <script>');
    assert(src.indexOf('<style') < 0, rel(f) + ' 不应包含内联 <style>');
  });
});

test('列表渲染都带 wx:key', () => {
  mp('.wxml').forEach((f) => {
    const src = read(f);
    const blocks = [...src.matchAll(/wx:for\s*=[^>]*>/g)];
    blocks.forEach((b) => {
      assert(b[0].indexOf('wx:key') >= 0, rel(f) + ' 有一处 wx:for 缺少 wx:key：' + b[0].slice(0, 60));
    });
  });
});

/* ================================================================= */

group('WXSS');

test('WXSS 花括号配平', () => {
  mp('.wxss').forEach((f) => {
    const src = read(f);
    const ob = (src.match(/{/g) || []).length;
    const cb = (src.match(/}/g) || []).length;
    if (ob !== cb) throw new Error(rel(f) + ' 花括号不配平：{ ' + ob + ' } ' + cb);
  });
});

test('WXSS 不使用 :root（小程序里根选择器是 page）', () => {
  mp('.wxss').forEach((f) => {
    const src = stripCssComments(read(f));
    assert(!/:root\b/.test(src), rel(f) + ' 使用了 :root，小程序里必须写在 page 上');
  });
});

test('全局样式定义了完整的设计 token', () => {
  const src = read(path.join(MP, 'app.wxss'));
  ['--bg-app', '--surface', '--text-1', '--brand-500', '--brand-gradient', '--line', '--sh-2', '--r-lg', '--pad-card']
    .forEach((t) => {
      assert(src.indexOf(t + ':') >= 0, 'app.wxss 缺少设计 token ' + t);
    });
  assert(src.indexOf('prefers-color-scheme: dark') >= 0, 'app.wxss 应提供深色模式');
  assert(src.indexOf('prefers-reduced-motion') >= 0, 'app.wxss 应提供动效降级');
});

/** 取出某个选择器块里声明的 token 名字集合 */
function tokensOf(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(esc + '\\s*\\{([\\s\\S]*?)\\}', 'g');
  const names = new Set();
  let m;
  while ((m = re.exec(css))) {
    (m[1].match(/--[a-z0-9-]+\s*:/gi) || []).forEach((d) => names.add(d.replace(/\s*:$/, '')));
  }
  return names;
}

/**
 * 取出某个选择器「每一处」匹配块各自的 token 集合（按出现顺序）。
 * tokensOf 会把同名选择器的多个块合并成一个并集，而这里需要分开看：
 * page 有两处（浅色默认 + @media 深色覆盖），合并后就看不出深浅了。
 */
function blockTokenSets(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 前面要求边界，避免 .page{ 被当成 page{
  const re = new RegExp('(?:^|[\\s;}])' + esc + '\\s*\\{', 'g');
  const sets = [];
  let m;
  while ((m = re.exec(css))) {
    const i = m.index + m[0].length - 1;
    let depth = 0;
    let j = i;
    while (j < css.length) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') { depth -= 1; if (depth === 0) break; }
      j += 1;
    }
    const body = css.slice(i + 1, j);
    const set = new Set();
    (body.match(/--[a-z0-9-]+\s*:/gi) || []).forEach((d) => set.add(d.replace(/\s*:$/, '')));
    if (set.size > 5) sets.push(set);
  }
  return sets;
}

test('主题块覆盖关系正确：浅色完整、深色只覆盖差异项', () => {
  const css = stripCssComments(read(path.join(MP, 'app.wxss')));

  // 设计基准的结构是：:root 完整一套浅色 + [data-theme="dark"] 只覆盖差异项。
  // 所以「手动深色」本来就该是部分覆盖，不该要求和浅色等量 —— 那是错误的前提。
  const pageBlocks = blockTokenSets(css, 'page');
  eq(pageBlocks.length, 2, 'page 应有两处声明（浅色默认 + 媒体查询深色），实际 ' + pageBlocks.length);
  const pageLight = pageBlocks[0];
  const pageDark = pageBlocks[1];

  const darkBlocks = blockTokenSets(css, '.theme-dark');
  const lightBlocks = blockTokenSets(css, '.theme-light');
  eq(darkBlocks.length, 1, '.theme-dark 应只有一处声明');
  eq(lightBlocks.length, 1, '.theme-light 应只有一处声明');
  const manualDark = darkBlocks[0];
  const manualLight = lightBlocks[0];

  assert(pageLight.size > 100, '浅色默认 token 偏少：' + pageLight.size);
  assert(pageDark.size > 30, '深色覆盖 token 偏少：' + pageDark.size);

  // ① 手动深色必须与「系统深色」覆盖完全同一组 token。
  //    否则同一台手机在「跟随系统(深色)」和「手动深色」下会呈现两套颜色。
  const missInManualDark = [...pageDark].filter((t) => !manualDark.has(t));
  const extraInManualDark = [...manualDark].filter((t) => !pageDark.has(t));
  eq(missInManualDark.length, 0, '手动深色缺少系统深色覆盖的：' + missInManualDark.join(','));
  eq(extraInManualDark.length, 0, '手动深色多出系统深色没有的：' + extraInManualDark.join(','));

  // ② 系统处于深色时，用户切到浅色，必须能把深色改过的每个 token 都改回来，
  //    否则会残留深色（典型表现：深色底上出现浅色文字，或反过来）。
  const stuckDark = [...pageDark].filter((t) => !manualLight.has(t));
  eq(stuckDark.length, 0, '切浅色后会残留深色的 token：' + stuckDark.join(','));

  // ③ 深色查询覆盖到的每个 token，必须在浅色默认值里有定义。
  //    反过来（浅色的每个 token 都要在深色里再写一遍）不成立 ——
  //    像 --pad-page / --pad-nav 这类间距 token 不随主题变化，
  //    要求它们在两套主题里各声明一次纯属冗余。
  const noBase = [...pageDark].filter((t) => !pageLight.has(t));
  eq(noBase.length, 0, '深色覆盖了但浅色默认值里没有定义的 token：' + noBase.join(','));
});

test('每个页面都把主题类挂在根容器上', () => {
  const pages = appJson.pages;
  pages.forEach((p) => {
    const wxml = read(path.join(MP, p + '.wxml'));
    assert(wxml.indexOf('{{themeClass}}') >= 0, p + '.wxml 的根容器缺少 {{themeClass}}');
    const js = read(path.join(MP, p + '.js'));
    assert(js.indexOf('themeClassOf') >= 0, p + '.js 没有计算 themeClass');
  });
  const tabWxml = read(path.join(MP, 'custom-tab-bar', 'index.wxml'));
  assert(tabWxml.indexOf('{{themeClass}}') >= 0, '自定义 tabBar 缺少主题类');
});

test('WXSS 不引用外部资源', () => {
  mp('.wxss').forEach((f) => {
    const src = read(f);
    assert(!/url\(\s*['"]?https?:/i.test(src), rel(f) + ' 引用了外部资源');
    assert(src.indexOf('@import') < 0 || !/@import\s+url/i.test(src), rel(f) + ' 使用了外部 @import');
  });
});

/**
 * +1 是「看着像不像设计稿」的第一顺位元素。
 * 基准里它的紫色是**独立硬编码**（.plus1 的 radial-gradient），不属于品牌蓝 8 阶，
 * 所以这里把四个色标钉死：谁把它改成 var(--brand-gradient) 或 #007AFF 都会红。
 */
test('+1 主按钮使用基准的紫色渐变，不是品牌蓝', () => {
  const css = stripCssComments(read(path.join(MP, 'pages', 'today', 'today.wxss')));
  const start = css.indexOf('\n.plus1{');
  assert(start >= 0, 'today.wxss 找不到 .plus1 主按钮规则');
  const body = css.slice(start, css.indexOf('\n}', start));

  ['122% 122% at 30% 16%', '#A794F7', '#8A6BF3', '#6D4AF2', '#4A26C4'].forEach((k) => {
    assert(body.indexOf(k) >= 0, '.plus1 缺少基准值 ' + k);
  });
  assert(body.toUpperCase().indexOf('#007AFF') < 0, '.plus1 不应出现品牌蓝 #007AFF');
  assert(!/var\(--brand-gradient/.test(body), '.plus1 不应套用 --brand-gradient');
});

test('+1 主按钮结构对齐基准：呼吸光 + 斜向高光 + 下缘反光', () => {
  const wxml = read(path.join(MP, 'pages', 'today', 'today.wxml'));
  const css = stripCssComments(read(path.join(MP, 'pages', 'today', 'today.wxss')));
  assert(wxml.indexOf('class="plus1-glow"') >= 0, '缺少呼吸光节点 .plus1-glow');
  assert(wxml.indexOf('class="plus1-sheen"') >= 0, '缺少斜向高光节点 .plus1-sheen');
  assert(css.indexOf('.plus1-sheen{') >= 0, '.plus1-sheen 没有样式');
  assert(css.indexOf('.plus1::after{') >= 0, '缺少下缘反光 .plus1::after');
  assert(css.indexOf('p1Breathe') >= 0, '缺少呼吸动画 p1Breathe');
});

/**
 * 连击特效是「节点长出来」的效果，最容易出的事故不是不好看，
 * 而是节点数失控（基准 110 片彩带放到小程序里就是 110 个真实节点）。
 * 所以这里同时钉住「四层都在」与「预算没超」。
 */
test('+1 连击反馈：四层特效齐全，且节点数被限制在预算内', () => {
  const wxml = read(path.join(MP, 'pages', 'today', 'today.wxml'));
  const css = stripCssComments(read(path.join(MP, 'pages', 'today', 'today.wxss')));
  const js = read(path.join(MP, 'pages', 'today', 'today.js'));

  ['class="p1-ring', 'class="p1-spark', 'class="p1-float', 'class="confetti-bit', 'class="confetti-glow']
    .forEach((k) => { assert(wxml.indexOf(k) >= 0, 'today.wxml 缺少节点 ' + k); });

  ['p1PopA', 'p1PopB', 'p1Glow', 'p1Charged', 'p1Float', 'p1Ring', 'p1Spark', 'confettiFall', 'confettiGlow']
    .forEach((k) => { assert(css.indexOf('@keyframes ' + k) >= 0, 'today.wxss 缺少关键帧 ' + k); });

  assert(js.indexOf('const FX_MAX = 3') >= 0, '爆发组上限必须是 3（峰值节点 3 × 13 = 39）');
  assert(js.indexOf('const SPARK_N = 10') >= 0, '首击粒子数应取基准的 10');
  assert(js.indexOf('const SPARK_N_COMBO = 6') >= 0, '连击时粒子应减到 6');
  assert(js.indexOf('const CONFETTI_N = 24') >= 0, '彩带片数应降到 24（基准 110 会撑爆节点预算）');

  // 全屏 fixed 层如果不放行点击，整页会直接点不动 —— 这是最致命的一种回归
  assert(/\.p1-fx\{[^}]*pointer-events:none/.test(css), '.p1-fx 必须 pointer-events:none');
  assert(/\.confetti-layer\{[^}]*pointer-events:none/.test(css), '.confetti-layer 必须 pointer-events:none');
});

/* ================================================================= */

group('资源与外部请求');

test('小程序端不发起任何非云开发的网络请求', () => {
  mp('.js').forEach((f) => {
    const src = read(f);
    assert(src.indexOf('wx.request(') < 0, rel(f) + ' 使用了 wx.request，本项目所有后端调用都应走云函数');
    assert(!/https?:\/\/(?!developers\.weixin\.qq\.com)/.test(src), rel(f) + ' 出现了外部 URL');
  });
});

test('wx.cloud.init 只在 app.js 里调用一次', () => {
  const hits = mp('.js').filter((f) => read(f).indexOf('wx.cloud.init(') >= 0).map(rel);
  eq(hits.length, 1, 'wx.cloud.init 应只出现一次，实际：' + hits.join(', '));
  eq(hits[0], 'miniprogram/app.js');
});

test('云开发环境 ID 集中在一处配置，便于部署时替换', () => {
  const cfg = read(path.join(MP, 'utils', 'config.js'));
  assert(/const ENV_ID\s*=/.test(cfg), 'config.js 应导出 ENV_ID');
  const others = mp('.js').filter((f) => rel(f) !== 'miniprogram/utils/config.js' && /ENV_ID\s*=\s*['"][^'"]+['"]/.test(read(f)));
  eq(others.length, 0, 'ENV_ID 不应在别处硬编码：' + others.map(rel).join(', '));
});

test('不出现 emoji（设计约束：图标一律用内联 SVG 或纯 CSS）', () => {
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
  MP_FILES.concat(CF_FILES).forEach((f) => {
    if (!/\.(js|wxml|wxss|json)$/.test(f)) return;
    const src = read(f);
    if (emoji.test(src)) {
      const hit = src.match(emoji);
      throw new Error(rel(f) + ' 含 emoji：' + hit[0]);
    }
  });
});

/* ================================================================= */

group('云函数结构');

test('两个云函数都有入口与依赖声明', () => {
  ['auth', 'sync'].forEach((fn) => {
    assert(fs.existsSync(path.join(CF, fn, 'index.js')), fn + ' 缺少 index.js');
    assert(fs.existsSync(path.join(CF, fn, 'package.json')), fn + ' 缺少 package.json');
  });
});

test('云函数入口都做了统一错误封装，不把异常直接抛给客户端', () => {
  ['auth', 'sync'].forEach((fn) => {
    const src = read(path.join(CF, fn, 'index.js'));
    assert(src.indexOf('try {') >= 0, fn + '/index.js 缺少 try 包裹');
    assert(src.indexOf('toEnvelope(err)') >= 0, fn + '/index.js 未走 toEnvelope 统一封装');
    assert(src.indexOf('cloud.init(') >= 0, fn + '/index.js 未初始化云开发');
  });
});

test('认证动作齐全（一键登录 / 当前账号 / 改昵称 / 注销 / 健康检查）', () => {
  const src = read(path.join(CF, 'auth', 'lib', 'service.js'));
  ['login', 'me', 'updateProfile', 'deleteAccount', 'ping'].forEach((a) => {
    assert(src.indexOf('actions.' + a + ' =') >= 0, '缺少动作：' + a);
  });
});

test('同步动作齐全（拉取 / 推送 / 统计 / 清空）', () => {
  const src = read(path.join(CF, 'sync', 'lib', 'service.js'));
  ['pull', 'push', 'stats', 'wipe'].forEach((a) => {
    assert(src.indexOf('function ' + a + '(') >= 0, '缺少同步动作：' + a);
  });
});

/* ================================================================= */

group('安全基线（源码层面）');

/**
 * 身份模型已收敛为 openid。密码、令牌、验证码、锁定、限流这一整套机制
 * 必须真的消失，而不是留在那里没人调 —— 死代码比没代码更危险：
 * 它会让人以为「我们还保护着密码」，实际那条链路早就没人维护了。
 */
test('授权模型只剩 openid：密码 / 令牌 / 验证码机制必须真的消失', () => {
  const files = fs.readdirSync(path.join(CF, 'auth', 'lib')).filter((f) => f.endsWith('.js')).sort();
  eq(files.join(','), 'errors.js,repo.js,service.js', 'auth/lib 不应再有密码或会话相关的文件');

  const svc = read(path.join(CF, 'auth', 'lib', 'service.js'));
  ['passwordHash', 'verifyPassword', 'hashToken', 'tokenHash', 'issueSession'].forEach((k) => {
    assert(svc.indexOf(k) < 0, 'service.js 里不应再出现 ' + k);
  });

  const repo = read(path.join(CF, 'auth', 'lib', 'repo.js'));
  assert(repo.indexOf('SESSIONS') < 0, 'repo 不应再引用 sessions 集合');
});

test('身份只认云函数注入的 openid，不接受请求体里的任何身份字段', () => {
  ['auth', 'sync'].forEach((fn) => {
    const src = read(path.join(CF, fn, 'lib', 'service.js'));
    assert(src.indexOf('ctx.openid') >= 0, fn + ' 应使用 ctx.openid');
    assert(src.indexOf('payload.openid') < 0, fn + ' 不应信任请求体里的 openid');
    assert(src.indexOf('payload.userId') < 0, fn + ' 不应信任请求体里的 userId');
  });
});

test('所有数据访问都按账号归属过滤（防越权）', () => {
  const src = read(path.join(CF, 'sync', 'lib', 'service.js'));
  assert(src.indexOf('account._id') >= 0, '应使用 openid 查出来的账号 id');
  assert(src.indexOf('requireAccount(ctx)') >= 0, '每个动作都应先确认身份');
});

test('客户端不保存任何凭据：本地缓存里只有 user', () => {
  const src = read(path.join(MP, 'utils', 'auth.js'));
  assert(src.indexOf('token') < 0, 'auth.js 不应再出现 token');
  assert(src.indexOf('K.USER') >= 0, '应只缓存 user');
});

/**
 * 玻璃有两件事必须同时成立，否则真机上会「一半好看一半难看」：
 *   1. iOS 只认 -webkit-backdrop-filter，漏写前缀 = 那台机器上完全没有磨砂；
 *   2. 底色必须本身就是半透明色（--glass-bg / --gb-face-2），
 *      这样不支持模糊的机型退化成的是一块浅色面板，而不是透明窟窿。
 */
test('玻璃样式都带 -webkit- 前缀，且弹层有可降级的底色', () => {
  mp('.wxss').forEach((f) => {
    const src = stripCssComments(read(f));
    const bare = (src.match(/(?<!-webkit-)backdrop-filter\s*:/g) || []).length;
    const prefixed = (src.match(/-webkit-backdrop-filter\s*:/g) || []).length;
    eq(bare, prefixed, rel(f) + ' 的 backdrop-filter 必须同时写 -webkit- 前缀');
  });

  const css = stripCssComments(read(path.join(MP, 'app.wxss')));
  const sheet = css.match(/\.sheet\{[\s\S]*?\n\}/);
  assert(sheet, 'app.wxss 里找不到 .sheet');
  assert(sheet[0].indexOf('--glass-bg') >= 0, '.sheet 应以 --glass-bg 作可降级底色');
  assert(sheet[0].indexOf('backdrop-filter') >= 0, '.sheet 应是磨砂玻璃');
  assert(css.indexOf('--bg-glow') >= 0, '.page 应有可透的底色层次（--bg-glow）');
});

/**
 * 产品原则：界面上只放功能，不解释「我们为什么这么做」。
 * 数据流向、身份模型这些属于 README / 部署文档，放到界面上会让用户
 * 觉得这个产品「有事瞒着我」—— 恰恰是说明本身制造的异样感。
 */
/**
 * 底部导航是「一眼看出这不是原生小程序」的地方，也是最容易被改回原样的一处。
 * 基准 .nav 的形态：磨砂玻璃容器 + 发丝上边 + 选中项整枚玻璃胶囊，
 * 不是「文字变色 + 顶部一小条指示线」。
 */
test('底部导航对齐基准 .nav：玻璃胶囊选中态 + 容器发丝边', () => {
  const css = stripCssComments(read(path.join(MP, 'custom-tab-bar', 'index.wxss')));
  const js = read(path.join(MP, 'custom-tab-bar', 'index.js'));

  /* saturation 140 取自 liquid-glass-react 的默认值 */
  assert(/\.tabbar\{[\s\S]*?blur\(20px\) saturate\(140%\)/.test(css), '容器应是 blur(20px) saturate(140%)');
  assert(/\.tabbar\{[\s\S]*?border-top:1px solid var\(--line\)/.test(css), '容器应有发丝上边');
  assert(/\.tab\.on\{[\s\S]*?linear-gradient\(180deg,rgba\(0,122,255,\.16\)/.test(css), '选中态应是品牌色渐变胶囊');
  assert(/\.tab\.on\{[\s\S]*?inset 0 \.5px 0 rgba\(255,255,255,\.78\)/.test(css), '选中态应有玻璃上缘高光');
  /* 每一格是 Liquid Glass 语义的按键（参照 @callstack/liquid-glass）：
     clear 档未选中 / regular+tint 选中 / interactive 按压 / spacing 融合 */
  assert(/\.tab\{[\s\S]*?linear-gradient\(180deg,rgba\(255,255,255,\.14\)/.test(css),
    '未选中应是 clear 档（更透明，底面 .14 → .05）');
  assert(css.indexOf('.tab::after') >= 0, '每格应有镜面高光层');
  assert(/\.tab:active\{[\s\S]*?filter:brightness\(1\.06\)/.test(css),
    '按下应提亮（interactive 是「响应手指」，不是只变暗）');
  assert(/\.tab:active\{[\s\S]*?inset 0 2px 6px/.test(css), '按下应有内阴影（塌陷感）');
  assert(css.indexOf('.tabbar.theme-dark .tab{') >= 0, '深色下玻璃要换一套，不能照抄白色');
  assert(/\.tabbar-inner\{[\s\S]*?gap:2px/.test(css), 'container spacing：格子间距要收到 2px 才有融合感');

  /* 今日图标必须是「右上角开口」的清单：四段拼出来，勾从缺口穿出 */
  ['.ico-today .g1', '.ico-today .g2', '.ico-today .g3', '.ico-today .g4']
    .forEach((sel) => { assert(css.indexOf(sel) >= 0, '今日图标缺少 ' + sel + '（缺口结构）'); });
  assert(/\.ico-today \.g1\{[\s\S]*?border-left:2px/.test(css), '方框应只画左边/底边，右上角要留口');
  assert(/\.ico-today \.g2\{[\s\S]*?top:1\.4px/.test(css), '上边应是独立短段');

  /* 折射做不到，用边缘内发光近似 —— 这条防止有人把它当装饰删掉 */
  assert(/\.tab\{[\s\S]*?inset 0 0 12px rgba\(255,255,255,\.10\)/.test(css),
    '每格应有边缘内发光（折射的近似）');

  /* 基准手机端：选中项 = 玻璃胶囊 + 底部一条 18px 短横线（缺一都不像） */
  assert(css.indexOf('.tab.on::before') >= 0, '选中态应有一条短横线');
  assert(/\.tab\.on::before\{[\s\S]*?bottom:2px/.test(css), '短横线应在底部（bottom:2px）');
  assert(/\.tab\.on::before\{[\s\S]*?width:18px/.test(css), '短横线宽 18px');

  ['今日打卡', '进度看板', '周报复盘'].forEach((t) => {
    assert(js.indexOf(t) >= 0, '页签文字应是「' + t + '」');
  });
});

/**
 * 顶部 hero 是自绘的（navigationStyle: custom），没有系统导航栏兜底。
 * 一旦某页漏了 navigationStyle 或漏了状态栏配色，表现就是「标题被胶囊压住」
 * 或「深蓝头 + 黑字状态栏」—— 这两种只在真机上看得出来，所以用静态断言先兜住。
 */
test('四个 tab 页都用自绘 hero，且状态栏配色跟着页面头部走', () => {
  const pages = ['today', 'board', 'weekly', 'mine'];
  const heroFiles = ['index.js', 'index.json', 'index.wxml', 'index.wxss'];

  heroFiles.forEach((f) => {
    assert(fs.existsSync(path.join(MP, 'components', 'app-hero', f)), 'hero 组件缺少 ' + f);
  });

  pages.forEach((p) => {
    const cfg = JSON.parse(read(path.join(MP, 'pages', p, p + '.json')));
    eq(cfg.navigationStyle, 'custom', p + '.json 应使用自定义导航栏');
    assert(cfg.usingComponents && cfg.usingComponents['app-hero'], p + '.json 应引入 app-hero');

    const wxml = read(path.join(MP, 'pages', p, p + '.wxml'));
    assert(wxml.indexOf('<app-hero') >= 0, p + '.wxml 应使用 <app-hero>');
    assert(wxml.indexOf('class="page-title"') < 0, p + '.wxml 不该再有 page-title（标题在 hero 里）');

    const js = read(path.join(MP, 'pages', p, p + '.js'));
    assert(js.indexOf('setStatusBarLight(true)') >= 0, p + '.js 应在 onShow 里把状态栏改成白字');
  });

  ['login', 'goal-edit'].forEach((p) => {
    const js = read(path.join(MP, 'pages', p, p + '.js'));
    assert(js.indexOf('setStatusBarLight(false)') >= 0, p + '.js 应把状态栏还原成黑字');
  });
});

/**
 * 「我的」是 iOS 设置页的形态：分组卡片 + 发丝分隔 + 行内按下高光 + 开关。
 * 这层最容易被后续改动带偏（比如把 .mine-btn 改成圆角按钮）。
 */
test('我的页保持 iOS 分组列表形态', () => {
  const css = stripCssComments(read(path.join(MP, 'pages', 'mine', 'mine.wxss')));
  const wxml = read(path.join(MP, 'pages', 'mine', 'mine.wxml'));

  ['mine-btn', 'mine-ico', 'mine-sub', 'switch', 'knob', 'sync-row', 'sync-dot']
    .forEach((k) => { assert(css.indexOf('.' + k) >= 0, '样式缺少 .' + k); });

  assert(/\.mine-btn\{[\s\S]*?border-bottom:\.5px solid var\(--line\)/.test(css), '行分隔应是 .5px 发丝线');
  assert(/\.mine-btn:active\{[\s\S]*?inset 0 \.5px 0 rgba\(255,255,255,\.55\)/.test(css), '按下时应有玻璃高光');
  assert(css.indexOf('.mine-btn.danger') >= 0, '危险行有独立配色');

  /* 账号相关的入口只留「登录」和「注销账号」：
     登录后自动同步，不再摆手动同步 / 恢复 / 重置这些按钮 */
  ['偏好设置', '其他', '注销账号'].forEach((k) => {
    assert(wxml.indexOf(k) >= 0, '缺少「' + k + '」');
  });
  ['立即同步', '恢复此账号的数据', '重置这台手机', '退出登录'].forEach((k) => {
    assert(wxml.indexOf(k) < 0, '不该再出现「' + k + '」');
  });
});

/**
 * 界面上不出现「云端 / 本机 / 清空」这类词。
 * 它们描述的是实现（数据存在哪、怎么删），而用户只需要知道
 * 「这台手机上的记录被清掉了」或者「账号被注销了」。
 * 技术词出现在界面上只会制造焦虑，不会增加掌控感。
 */
test('「我的」页不出现云端 / 本机 / 清空这类词', () => {
  const wxml = read(path.join(MP, 'pages', 'mine', 'mine.wxml'));
  ['云端', '本机', '清空', '覆盖', '数据管理'].forEach((k) => {
    assert(wxml.indexOf(k) < 0, 'mine.wxml 不应出现「' + k + '」');
  });

  const store = read(path.join(MP, 'utils', 'store.js'));
  const uiTexts = store.match(/setPhase\([^)]*'[^']*'\)/g) || [];
  uiTexts.forEach((s) => {
    ['云端', '本机'].forEach((k) => {
      assert(s.indexOf(k) < 0, '同步状态文案不该出现「' + k + '」：' + s);
    });
  });
});

test('界面不解释数据流向：隐私说明只留在文档里', () => {
  const mine = read(path.join(MP, 'pages', 'mine', 'mine.wxml'));
  ['修改密码', '登录设备', '微信绑定', '关于你的数据', '数据跟着', '数据存在哪']
    .forEach((k) => { assert(mine.indexOf(k) < 0, 'mine.wxml 不应再出现「' + k + '」'); });
  assert(mine.indexOf('微信一键登录') >= 0, '未登录时应有一键登录入口');

  const today = read(path.join(MP, 'pages', 'today', 'today.wxml'));
  ['数据只在这台手机上', '数据只保存在这台设备', '跨设备']
    .forEach((k) => { assert(today.indexOf(k) < 0, 'today.wxml 不应再出现「' + k + '」'); });

  const login = read(path.join(MP, 'pages', 'login', 'login.wxml'));
  assert(login.indexOf('数据跟着') < 0, 'login.wxml 不应解释数据归属');
  assert(login.indexOf('数据存在哪') < 0, 'login.wxml 不应有「数据存在哪」入口');
});


/* ================================================================= */

group('分享分叉（模仿 H5 第 17 轮）');

/**
 * 分叉的正确性最终由 fork.test.mjs 的行为测试保证；
 * 这里只钉「结构没被改坏」：四个页签都能转发、入口和横幅还在。
 */
test('分叉模块存在，store 暴露完整入口', () => {
  const f = path.join(MP, 'utils', 'fork.js');
  assert(fs.existsSync(f), '缺少 utils/fork.js');
  const src = read(f);
  ['planIncoming', 'shareConfig', 'pendingWelcome', 'clearOnLogin'].forEach((k) => {
    assert(src.indexOf(k) >= 0, 'fork.js 缺少 ' + k);
  });

  const store = read(path.join(MP, 'utils', 'store.js'));
  ['applyShareQuery', 'reforkFromShare', 'forkWelcomePending', 'forkMarkWelcomed', 'forkInfo'].forEach((k) => {
    assert(store.indexOf(k) >= 0, 'store.js 缺少 ' + k);
  });
  assert(store.indexOf('fork.clearOnLogin()') >= 0, 'onLoggedIn 应清分叉记录');
});

test('四个页签都支持转发，路径由 fork.shareConfig 统一构造', () => {
  ['today', 'board', 'weekly', 'mine'].forEach((p) => {
    const js = read(path.join(MP, 'pages', p, p + '.js'));
    assert(js.indexOf('onShareAppMessage') >= 0, p + '.js 应定义 onShareAppMessage');
    assert(js.indexOf('fork.shareConfig') >= 0, p + '.js 应使用 fork.shareConfig');
  });
});

test('「我的」页有分享入口与（分叉态的）重新载入入口', () => {
  const wxml = read(path.join(MP, 'pages', 'mine', 'mine.wxml'));
  assert(wxml.indexOf('分享给同学') >= 0, '缺少「分享给同学」');
  assert(wxml.indexOf('open-type="share"') >= 0, '分享入口必须是 open-type=share 的 button');
  assert(wxml.indexOf('重新载入分享的目标') >= 0, '缺少「重新载入分享的目标」');
  assert(wxml.indexOf('wx:if="{{forked}}"') >= 0, '重新载入入口只在分叉态渲染');
});

test('今日页分叉欢迎横幅：品牌蓝配色 + 一辈子一次的闸门', () => {
  const wxml = read(path.join(MP, 'pages', 'today', 'today.wxml'));
  const css = stripCssComments(read(path.join(MP, 'pages', 'today', 'today.wxss')));
  const js = read(path.join(MP, 'pages', 'today', 'today.js'));

  assert(wxml.indexOf('class="fk-banner"') >= 0, '缺少横幅节点 .fk-banner');
  assert(wxml.indexOf('bindtap="dismissForkBanner"') >= 0, '横幅应可关闭');
  assert(js.indexOf('forkWelcomePending') >= 0 && js.indexOf('forkMarkWelcomed') >= 0,
    '横幅显隐必须走 store 的 welcomed 记录（一辈子只打一次）');

  // 参数取自基准 .sync-banner.fork：品牌蓝，不是错误红
  assert(/\.fk-banner\{[\s\S]*?background:var\(--brand-50\)/.test(css), '横幅底色应是 --brand-50');
  assert(!/\.fk-banner\{[\s\S]*?--danger-50/.test(css), '横幅不得用错误红配色');
  assert(/\.fk-banner\{[\s\S]*?blur\(16px\)/.test(css), '横幅应保留基准的 blur(16px)');
  assert(/\.fk-btn:active\{[\s\S]*?scale\(\.96\)/.test(css), '横幅按键按压应 scale(.96)（基准参数）');
});

test('按键统一为 iOS 毛玻璃（tint 染色玻璃 + 模糊），+1 主键除外', () => {
  const app = stripCssComments(read(path.join(MP, 'app.wxss')));
  const today = stripCssComments(read(path.join(MP, 'pages', 'today', 'today.wxss')));
  const weekly = stripCssComments(read(path.join(MP, 'pages', 'weekly', 'weekly.wxss')));
  const login = stripCssComments(read(path.join(MP, 'pages', 'login', 'login.wxss')));

  // 染色玻璃三件套：tint 底（半透明，可降级）+ 模糊 + tint 边光
  assert(/\.btn-primary\{[\s\S]*?background:var\(--gb-tint-brand\)/.test(app), '主键应是品牌染色玻璃');
  assert(/\.btn-primary\{[\s\S]*?backdrop-filter:var\(--gb-blur-sm\)/.test(app), '主键应带模糊');
  assert(/\.btn-danger\{[\s\S]*?--gb-tint-red/.test(app), '危险键应是红染色玻璃');
  assert(/\.tz-btn-red\{[\s\S]*?--gb-tint-red/.test(today), '立即打卡应是红染色玻璃');
  assert(/\.tz-btn-ghost\{[\s\S]*?--gb-face-2/.test(today), '调整计划应是清玻璃');
  assert(/\.btn-green\{[\s\S]*?--gb-tint-green/.test(weekly), '一键复制应是绿染色玻璃');
  assert(/\.btn-wx\{[\s\S]*?backdrop-filter:var\(--gb-blur-sm\)/.test(login), '微信登录键应是绿染色玻璃');

  // +1 是全站唯一发光体：紫色实底渐变，明确不参与玻璃系统
  const start = today.indexOf('\n.plus1{');
  const body = today.slice(start, today.indexOf('\n}', start));
  assert(body.indexOf('backdrop-filter') < 0, '+1 主键不应使用毛玻璃');
});

export const suite = '小程序静态检查';
