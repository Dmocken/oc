// 本地模拟 harness：用内存 store 替代 EdgeKV、可编程数据集替代 offerbiu，
// 加载 edge-function/api-proxy.js 源码并跑完整场景，部署前逻辑自检。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
    const u = String(url);
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
    throw new Error('mock 未覆盖的上游路径 ' + u);
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
  const fn = new Function('EdgeKV', 'fetch', src + '\nreturn __esModule;');
  const mod = fn(EdgeKvClass, makeUpstream(dataset, calls));
  return { worker: mod, calls };
}

const H = 'https://site.example.com';
let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}`, extra === undefined ? '' : extra); }
}
async function req(worker, path) {
  const resp = await worker.fetch(new Request(H + path));
  let body = null;
  try { body = await resp.json(); } catch { body = null; }
  return { status: resp.status, cache: resp.headers.get('X-Cache'), body };
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
