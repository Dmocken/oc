// 本地模拟 harness：用内存 store 替代 EdgeKV、可编程数据集替代 offerbiu，
// 加载 edge-function/api-proxy.js 源码并跑完整场景，部署前逻辑自检。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHmac, webcrypto } from 'node:crypto';

// —— 测试用参考实现：先用 RFC 6238 官方向量自检，再用它给 worker 喂正确口令 ——
const TEST_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // 32 字符 Base32 = 20 字节
const ENV = { TOTP_SECRET: TEST_SECRET };
const B32T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b32decode(s) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(s).toUpperCase().replace(/[=\s-]/g, '')) {
    const idx = B32T.indexOf(ch);
    if (idx < 0) throw new Error('bad base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Uint8Array.from(out);
}
function ctrBytes(counter) {
  const b = Buffer.alloc(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { b[i] = c & 0xff; c = Math.floor(c / 256); }
  return b;
}
function refHotp8(bytes, counter) {
  const mac = createHmac('sha1', Buffer.from(bytes)).update(ctrBytes(counter)).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 1e8).padStart(8, '0');
}
function refCode(secret, atSec = Math.floor(Date.now() / 1000)) {
  return refHotp8(b32decode(secret), Math.floor(atSec / 30)).slice(-6);
}
function refSession(secret) {
  return createHmac('sha1', Buffer.from(b32decode(secret))).update('oc-session-v1').digest('hex');
}
const AUTH_COOKIE = `oc_auth=${refSession(TEST_SECRET)}`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let src = readFileSync(join(root, 'edge-function', 'api-proxy.js'), 'utf8');
src = src.replace(/export default \{/, 'const __esModule = {');

function makeStore() {
  return new Map();
}
function makeEdgeKvClass(store) {
  return class EdgeKV {
    constructor({ namespace }) { this.ns = namespace; }
    async get(key, opts) {
      const v = store.get(`${this.ns}:${key}`);
      if (v === undefined) return undefined;
      return opts && opts.type === 'text' ? v : v;
    }
    async put(key, value) { store.set(`${this.ns}:${key}`, String(value)); }
    async delete(key) { return store.delete(`${this.ns}:${key}`); }
  };
}
function makeUpstream(dataset, calls) {
  return async function fetchLike(url) {
    // 平台允许 fetch(request) 传入 Request 对象（静态资源回源路径），此处统一取 URL
    const u = typeof url === 'string' ? url : url && url.url ? url.url : String(url);
    calls.push(u);
    const pu = new URL(u);
    const body = (o, status = 200) => new Response(JSON.stringify(o), { status });
    if (pu.pathname.includes('filter-options')) {
      return body({ success: true, code: 0, message: 'success', data: { recruitTypes: ['秋招', '春招', '实习', '社招'], industries: [], industryGroups: [], targetYears: [2027, 2026] } });
    }
    if (pu.pathname.includes('/postings')) {
      const page = Number(pu.searchParams.get('page')) || 0;
      const size = Number(pu.searchParams.get('size')) || 100;
      const recruitType = pu.searchParams.get('recruitType') || '';
      if (!recruitType && page >= 5) return body({ error: 'forbidden' }, 403); // 无筛选防深翻页
      const list = dataset.slice();
      const totalItems = list.length;
      return body({ success: true, code: 0, message: 'success', data: { items: list.slice(page * size, (page + 1) * size), page, size, totalItems, totalPages: Math.max(1, Math.ceil(totalItems / size)), previewLimited: false } });
    }
    // 非 offerbiu 的请求视为 Pages 静态资源回源
    return new Response('static-asset', { status: 200 });
  };
}

function mkAt(offsetMin) {
  // 基准 2026-09-01T00:00:00Z + offsetMin 分钟；offsetMin 越大时间越新（可排序）
  const t = Date.parse('2026-09-01T00:00:00Z') + offsetMin * 60 * 1000;
  return new Date(t).toISOString().replace('.000', '');
}
const TYPES = ['秋招', '秋招', '春招', '实习', '社招'];
function makeRecord(i) {
  return {
    id: `rec-2027-${String(i).padStart(4, '0')}`,
    seasonYear: 2027,
    companyName: `测试公司${String(i).padStart(3, '0')}`,
    companyNature: '民企',
    industry: '互联网',
    recruitType: TYPES[i % 5],
    targetYears: i % 7 === 0 ? [2026, 2027] : [2027],
    locations: ['北京'],
    positionsText: i % 11 === 0 ? `工程师岗${i}` : `后端开发岗位${i}`,
    deadlineAt: null,
    deadlineText: '',
    announcementUrl: '',
    applyUrl: `https://example.com/apply/${i}`,
    applyText: '申请',
    examPolicy: '',
    noteText: '',
    visibilityTier: 'PUBLIC',
    status: 'PUBLISHED',
    sourceUpdatedAt: mkAt(i * 60),
    importedAt: mkAt(i * 60),
    updatedAt: mkAt(i * 60),
  };
}

function buildDataset(n) {
  // 新纪录在前（importedAt 更大）：索引 i 越小 importedAt 越大
  const arr = [];
  for (let i = n - 1; i >= 0; i--) arr.push(makeRecord(i));
  return arr;
}

function buildWorker(dataset, store) {
  const calls = [];
  const EdgeKvClass = makeEdgeKvClass(store);
  const fn = new Function('EdgeKV', 'fetch', 'crypto', src + '\nreturn __esModule;');
  const mod = fn(EdgeKvClass, makeUpstream(dataset, calls), webcrypto);
  return { worker: mod, calls };
}

const H = 'https://site.example.com';
let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}`, extra === undefined ? '' : extra); }
}
async function req(worker, path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (!opts.noAuth) headers.Cookie = headers.Cookie || AUTH_COOKIE; // 默认携带有效会话
  const init = { method: opts.method || 'GET', headers };
  if (opts.body) {
    init.body = opts.body;
    init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/x-www-form-urlencoded';
  }
  const resp = await worker.fetch(new Request(H + path, init), {}, opts.env === undefined ? ENV : opts.env);
  const text = await resp.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return {
    status: resp.status,
    cache: resp.headers.get('X-Cache'),
    setCookie: resp.headers.get('Set-Cookie'),
    location: resp.headers.get('Location'),
    text,
    body,
  };
}

// ===== 场景 A：冷启动 → 直连透传 =====
{
  const dataset = buildDataset(80);
  const store = makeStore();
  const { worker, calls } = buildWorker(dataset, store);
  const r = await req(worker, '/api/recruitment/postings?seasonYear=2027&page=0&size=20');
  check('A1 冷启动透传 X-Cache=UPSTREAM', r.cache === 'UPSTREAM', r.cache);
  check('A2 透传返回上游首页数据', r.body && r.body.data && r.body.data.items.length === 20 && r.body.data.totalItems === 80, JSON.stringify(r.body && r.body.data));
}

// ===== 场景 B：分批预热 → final → 缓存命中 =====
{
  const dataset = buildDataset(80);
  const store = makeStore();
  const { worker, calls } = buildWorker(dataset, store);
  const s0 = await req(worker, '/api/sync?season=2027&key=oc-sync-2026a9f3c7e2&from=0&to=0');
  check('B1 分批拉取成功', s0.body && s0.body.ok && s0.body.got === 80, JSON.stringify(s0.body));
  const s1 = await req(worker, '/api/sync?season=2027&key=oc-sync-2026a9f3c7e2&final=1');
  check('B2 final 收尾 ready', s1.body && s1.body.ok && s1.body.ready && s1.body.built === 80, JSON.stringify(s1.body));
  const n1 = calls.length;
  const r = await req(worker, '/api/recruitment/postings?seasonYear=2027&page=0&size=20');
  check('B3 预热后缓存命中 HIT', r.cache === 'HIT', r.cache);
  check('B4 totalItems=80', r.body.data.totalItems === 80, r.body && r.body.data.totalItems);
  check('B5 首页第一条是最新记录', r.body.data.items[0].id === 'rec-2027-0079', r.body.data.items[0] && r.body.data.items[0].id);
  check('B6 命中期间零上游请求', calls.length === n1, calls.length - n1);
}

// ===== 场景 C：过期 → 懒增量 → 合并排序 =====
{
  const dataset = buildDataset(80);
  const store = makeStore();
  const { worker, calls } = buildWorker(dataset, store);
  await req(worker, '/api/sync?season=2027&key=oc-sync-2026a9f3c7e2&from=0&to=0');
  await req(worker, '/api/sync?season=2027&key=oc-sync-2026a9f3c7e2&final=1');
  // 模拟 offerbiu 凌晨新增 5 条（顶部插入，importedAt 最大）
  const newest = [];
  for (let k = 0; k < 5; k++) newest.push(makeRecord(1000 + k));
  dataset.unshift(...newest);
  // 使缓存过期
  const mk = store.get('oc:meta-2027');
  store.set('oc:meta-2027', JSON.stringify({ ...JSON.parse(mk), lastSyncAt: 0 }));
  const r = await req(worker, '/api/recruitment/postings?seasonYear=2027&page=0&size=20');
  check('C1 过期触发增量并返回 SYNCED', r.cache === 'SYNCED', r.cache);
  check('C2 totalItems=85', r.body.data.totalItems === 85, r.body.data.totalItems);
  check('C3 合并后最新记录排最前', r.body.data.items[0].id === 'rec-2027-1004', r.body.data.items[0] && r.body.data.items[0].id);
  // 再次访问应命中缓存且零上游
  const n2 = calls.length;
  const r2 = await req(worker, '/api/recruitment/postings?seasonYear=2027&page=0&size=20');
  check('C4 同步后回归 HIT 且零上游', r2.cache === 'HIT' && calls.length === n2, `${r2.cache} / ${calls.length - n2}`);
}

// ===== 场景 D：筛选与搜索语义 =====
{
  const dataset = buildDataset(80);
  const store = makeStore();
  const { worker, calls } = buildWorker(dataset, store);
  await req(worker, '/api/sync?season=2027&key=oc-sync-2026a9f3c7e2&from=0&to=0');
  await req(worker, '/api/sync?season=2027&key=oc-sync-2026a9f3c7e2&final=1');
  // targetYears 含 2026 的索引：i%7==0 → makeRecord 里 i%7===0 时含 2026；但 dataset 索引 0 是 makeRecord(79)…
  const ty2026 = dataset.filter((d) => d.targetYears.includes(2026)).length;
  const rT = await req(worker, '/api/recruitment/postings?seasonYear=2027&targetYear=2026&page=0&size=100');
  check('D1 targetYear=2026 过滤', rT.body.data.totalItems === ty2026, `${rT.body.data.totalItems} vs ${ty2026}`);
  // 秋招 = TYPES[0] 即 i%5===0
  const qiuzhao = dataset.filter((d) => d.recruitType === '秋招').length;
  const rQ = await req(worker, '/api/recruitment/postings?seasonYear=2027&recruitType=%E7%A7%8B%E6%8B%9B&page=0&size=100');
  check('D2 recruitType=秋招 精确 OR', rQ.body.data.totalItems === qiuzhao, `${rQ.body.data.totalItems} vs ${qiuzhao}`);
  // 关键词命中后端岗位
  const rS = await req(worker, '/api/recruitment/postings?seasonYear=2027&q=%E5%90%8E%E7%AB%AF&page=0&size=100');
  check('D3 q=后端 命中公司/岗位文本', rS.body.data.totalItems > 0, rS.body.data.totalItems);
  // filter-options：先 MISS 后 HIT，第二次不再打上游
  const rO1 = await req(worker, '/api/recruitment/filter-options?seasonYear=2027');
  const n3 = calls.length;
  const rO2 = await req(worker, '/api/recruitment/filter-options?seasonYear=2027');
  check('D4 filter-options MISS→HIT', rO1.cache === 'MISS' && rO2.cache === 'HIT', `${rO1.cache} → ${rO2.cache}`);
  check('D5 filter-options 二次命中零上游', calls.length === n3, calls.length - n3);
}

// ===== 场景 E：锁窗口防并发 =====
{
  const dataset = buildDataset(80);
  const store = makeStore();
  const { worker, calls } = buildWorker(dataset, store);
  await req(worker, '/api/sync?season=2027&key=oc-sync-2026a9f3c7e2&from=0&to=0');
  await req(worker, '/api/sync?season=2027&key=oc-sync-2026a9f3c7e2&final=1');
  dataset.unshift(...[makeRecord(1000)]); // 有新数据可拉
  const mk = store.get('oc:meta-2027');
  store.set('oc:meta-2027', JSON.stringify({ ...JSON.parse(mk), lastSyncAt: 0 }));
  store.set('oc:lock-2027', String(Date.now())); // 模拟另一节点正在同步
  const n4 = calls.length;
  const r = await req(worker, '/api/recruitment/postings?seasonYear=2027&page=0&size=20');
  check('E1 锁占用时跳过同步仍返回缓存', r.cache === 'HIT' && r.body.data.totalItems === 80, `${r.cache} / ${r.body.data.totalItems}`);
  check('E2 锁占用时零上游请求', calls.length === n4, calls.length - n4);
}

// ===== 场景 F：无新数据只刷新时间戳，不重复拉写 =====
{
  const dataset = buildDataset(80);
  const store = makeStore();
  const { worker, calls } = buildWorker(dataset, store);
  await req(worker, '/api/sync?season=2027&key=oc-sync-2026a9f3c7e2&from=0&to=0');
  await req(worker, '/api/sync?season=2027&key=oc-sync-2026a9f3c7e2&final=1');
  const mk = store.get('oc:meta-2027');
  store.set('oc:meta-2027', JSON.stringify({ ...JSON.parse(mk), lastSyncAt: 0 }));
  const n5 = calls.length;
  const r = await req(worker, '/api/sync?season=2027&key=oc-sync-2026a9f3c7e2&mode=refresh');
  check('F1 refresh 无新数据 changed=0', r.body && r.body.changed === 0, JSON.stringify(r.body));
  const r2 = await req(worker, '/api/recruitment/postings?seasonYear=2027&page=0&size=20');
  check('F2 无新数据访问为 HIT', r2.cache === 'HIT', r2.cache);
  const r3 = await req(worker, '/api/sync?season=2027&key=oc-sync-2026a9f3c7e2&status=1');
  check('F3 status 端点返回 meta', r3.body && r3.body.ready && r3.body.meta.count === 80, JSON.stringify(r3.body && r3.body.meta));
}

// ===== 场景 G：预热中途 postings 不透传半成品（应继续 UPSTREAM）=====
{
  const dataset = buildDataset(80);
  const store = makeStore();
  const { worker } = buildWorker(dataset, store);
  await req(worker, '/api/sync?season=2027&key=oc-sync-2026a9f3c7e2&from=0&to=0'); // 只写了 stage，未 final
  const r = await req(worker, '/api/recruitment/postings?seasonYear=2027&page=0&size=20');
  check('G1 未 final 前 postings 仍 UPSTREAM', r.cache === 'UPSTREAM', r.cache);
}

// ===== 场景 H：TOTP 访问鉴权 =====
{
  // H0 参考实现自检：RFC 6238 官方测试向量（SHA-1 / 8 位 / 30s）
  const vecSecret = Buffer.from('12345678901234567890', 'ascii');
  const vectors = [
    [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'],
  ];
  for (const [t, expect] of vectors) {
    const got = refHotp8(vecSecret, Math.floor(t / 30));
    check(`H0 T=${t} 向量=${expect}`, got === expect, got);
  }

  const dataset = buildDataset(80);
  const store = makeStore();
  const { worker } = buildWorker(dataset, store);
  await req(worker, '/api/sync?season=2027&key=oc-sync-2026a9f3c7e2&from=0&to=0');
  await req(worker, '/api/sync?season=2027&key=oc-sync-2026a9f3c7e2&final=1');

  // H1 未登录访问页面 → 登录页
  const p1 = await req(worker, '/', { noAuth: true });
  check('H1 未登录访问页面 → 登录页', p1.status === 200 && p1.text.includes('<form') && p1.text.includes('GiveMeOC'), p1.status);

  // H2 未登录访问数据 API → 401
  const a1 = await req(worker, '/api/recruitment/postings?seasonYear=2027&page=0&size=20', { noAuth: true });
  check('H2 未登录访问数据 API → 401', a1.status === 401 && a1.body.error === 'unauthorized', a1.status);

  // H3 未配置密钥 → 拒绝一切（fail-closed）
  const noEnv = await req(worker, '/', { noAuth: true, env: {} });
  const noEnvApi = await req(worker, '/api/recruitment/postings?seasonYear=2027', { noAuth: true, env: {} });
  check('H3 未配置 TOTP_SECRET → 页面也拒绝', noEnv.status === 500, noEnv.status);
  check('H3b 未配置密钥时 API 同样拒绝', noEnvApi.status === 500, noEnvApi.status);

  // H4 错误口令
  const bad = await req(worker, '/api/login', { noAuth: true, method: 'POST', body: 'code=000000&next=/' });
  check('H4 错误口令 → 401', bad.status === 401, bad.status);
  check('H4b 错误口令不下发 Cookie', !bad.setCookie, bad.setCookie);

  // H5 正确口令（由已自检的参考实现生成）
  const code = refCode(TEST_SECRET);
  const ok = await req(worker, '/api/login', { noAuth: true, method: 'POST', body: `code=${code}&next=/` });
  check('H5 正确口令 → 303 跳转', ok.status === 303, ok.status);
  check('H5b 下发 HttpOnly 会话 Cookie', !!ok.setCookie && ok.setCookie.includes('oc_auth=') && ok.setCookie.includes('HttpOnly'), ok.setCookie);

  // H6 携带会话访问数据
  const hit = await req(worker, '/api/recruitment/postings?seasonYear=2027&page=0&size=20', { headers: { Cookie: AUTH_COOKIE } });
  check('H6 带会话可访问数据(80 条)', hit.status === 200 && hit.body.data.totalItems === 80, hit.status);

  // H7 伪造 Cookie
  const fake = await req(worker, '/api/recruitment/postings?seasonYear=2027&page=0&size=20', { headers: { Cookie: 'oc_auth=deadbeef' } });
  check('H7 伪造 Cookie → 401', fake.status === 401, fake.status);

  // H8 防重放
  const replay = await req(worker, '/api/login', { noAuth: true, method: 'POST', body: `code=${code}&next=/` });
  check('H8 同一口令重放被拒', replay.status === 401 && replay.text.includes('已使用过'), replay.status);

  // H9 登出
  const out = await req(worker, '/api/logout', { noAuth: true });
  check('H9 登出清除 Cookie', out.status === 303 && !!out.setCookie && /Max-Age=0/.test(out.setCookie), out.setCookie);

  // H10/H11 静态资源（登录页样式/图标）在未登录与已登录下均可用
  const s1 = await req(worker, '/assets/index-abc.js', { noAuth: true });
  check('H10 未登录可加载静态资源', s1.status === 200 && s1.text === 'static-asset', s1.status);
  const s2 = await req(worker, '/assets/index-abc.js', { headers: { Cookie: AUTH_COOKIE } });
  check('H11 已登录可加载静态资源', s2.status === 200 && s2.text === 'static-asset', s2.status);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
