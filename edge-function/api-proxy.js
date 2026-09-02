// 阿里云 ESA Pages 边缘函数：offerbiu 招聘 API 懒缓存网关（Stale-While-Revalidate）
//
// 读路径（用户访问 /api/recruitment/postings）：
//   1) KV 缓存新鲜(meta.lastSyncAt 距今 < SYNC_TTL) → 本地过滤/分页，零上游请求
//   2) 缓存过期且无人在同步(lock 空闲) → 顺手增量：只翻列表头 MAX_INC_PAGES 页，收 importedAt > maxImportedAt
//   3) 有人在同步 → 直接用现有缓存返回(允许陈旧, SWR)
//   4) KV 未就绪(meta.ready=0, 冷启动过渡期) → 直连透传 offerbiu 原样响应
//
// 管理端点（冷启动预热/强制刷新/状态）：
//   GET /api/sync?season=2027&key=<SYNC_KEY>[&status=1 | &from=0&to=7 | &final=1 | &mode=refresh]
//   注意：EdgeKV 无列表 API，stage 批次由 meta.staged 记录；final 时聚合全部 stage 建 data。
//
// 数据布局（Key 仅 [a-zA-Z0-9_-]，namespace = oc）：
//   meta-{season}         元数据 { ready, version, count, chunkCount, maxImportedAt, lastSyncAt, staged[] }
//   data-{season}-{n}     全季记录 JSON 数组分片（每片 < 1.8MB 限额）
//   stage-{season}-{from} 预热分批暂存（每批 8 页 ≈ 0.9MB，远低于限额）
//   lock-{season}         同步互斥时间戳（无 CAS/无 TTL，用时间窗近似）
//   opt-{season}          filter-options 缓存

const KV_NAMESPACE = 'oc';

// 预热/管理接口密钥：部署前请改成自己的随机串（防止他人触发大量抓取）
const SYNC_KEY = 'oc-sync-2026a9f3c7e2';

const SYNC_TTL_MS = 30 * 60 * 1000; // 缓存新鲜窗口
const OPT_TTL_MS = 6 * 60 * 60 * 1000; // filter-options 新鲜窗口
const LOCK_TTL_MS = 90 * 1000; // 同步互斥窗口（覆盖一次增量拉取）
const MAX_INC_PAGES = 4; // 单次懒增量最多连拉页数（日常 1 页即够）
const PAGE_SIZE = 100; // 上游整页拉取条数
const CHUNK_BYTES_LIMIT = 1400000; // 单分片上限，留余量给结构符(<1.8MB)
const UPSTREAM = 'https://www.offerbiu.com';

// offerbiu 对无浏览器特征的请求限流，补齐以下请求头
const UPSTREAM_HEADERS = {
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  Referer: 'https://www.offerbiu.com/',
  'X-Requested-With': 'XMLHttpRequest',
};

// 2027 季真实全集（探测自 /filter-options）。预热全量分页必须携带以规避上游深翻页 403。
// 懒增量不依赖它：只翻 <5 页不会 403，可捕获任意新类型。
const RECRUIT_TYPES_FULL = [
  '春招', '春招补录', '春招专场', '寒假实习', '秋招', '秋招补录',
  '秋招提前批', '秋招专场', '日常实习', '社招', '实习', '暑期实习', '提前批',
];

const edgeKv = new EdgeKV({ namespace: KV_NAMESPACE });

// —— KV 封装 ——
async function kvGetText(key) {
  const v = await edgeKv.get(key, { type: 'text' });
  return v === undefined || v === null ? null : String(v);
}
async function kvPut(key, value) {
  await edgeKv.put(key, value);
}
async function kvDel(key) {
  await edgeKv.delete(key).catch(() => false);
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

function recSortKey(r) {
  return r && r.importedAt ? r.importedAt : '';
}

// 按 importedAt 降序稳定排序；同值保留原相对顺序（与 offerbiu 列表序一致）
function sortRecords(list) {
  return list.sort((a, b) => {
    const ta = recSortKey(a);
    const tb = recSortKey(b);
    if (ta === tb) return 0;
    return ta > tb ? -1 : 1;
  });
}

function splitChunks(records) {
  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const rec of records) {
    const inc = JSON.stringify(rec).length + 2;
    if (cur.length && curLen + inc > CHUNK_BYTES_LIMIT) {
      chunks.push(JSON.stringify(cur));
      cur = [];
      curLen = 0;
    }
    cur.push(rec);
    curLen += inc;
  }
  if (cur.length) chunks.push(JSON.stringify(cur));
  return chunks;
}

async function fetchOfferbiu(pathAndQuery) {
  const resp = await fetch(`${UPSTREAM}${pathAndQuery}`, { headers: UPSTREAM_HEADERS });
  if (!resp.ok) {
    const err = new Error(`上游 HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  if (!data || data.success === false) {
    const err = new Error(data?.message || '上游业务错误');
    err.status = 500;
    throw err;
  }
  return data;
}

// —— 元数据 ——
function emptyMeta(season) {
  return {
    season, ready: 0, version: 0, count: 0, chunkCount: 0,
    maxImportedAt: '', lastSyncAt: 0, lastUpdatedAt: 0, lastNewCount: 0, staged: [],
  };
}

async function readMeta(season) {
  const txt = await kvGetText(`meta-${season}`);
  if (!txt) return emptyMeta(season);
  try {
    return { ...emptyMeta(season), ...JSON.parse(txt) };
  } catch {
    return emptyMeta(season);
  }
}

// —— 全季数据读写 ——
async function readAllRecords(season) {
  const meta = await readMeta(season);
  if (!meta.ready || !meta.chunkCount) return { meta, records: null };
  let records = [];
  for (let i = 0; i < meta.chunkCount; i++) {
    const txt = await kvGetText(`data-${season}-${i}`);
    if (!txt) return { meta, records: null }; // 缺片视为未就绪
    records = records.concat(JSON.parse(txt));
  }
  return { meta, records };
}

async function writeAllRecords(season, records, patch = {}) {
  const oldMeta = await readMeta(season);
  const chunks = splitChunks(records);
  for (let i = 0; i < chunks.length; i++) await kvPut(`data-${season}-${i}`, chunks[i]);
  for (let i = chunks.length; i < (oldMeta.chunkCount || 0); i++) await kvDel(`data-${season}-${i}`);
  const now = Date.now();
  const meta = {
    ...oldMeta, ...patch,
    ready: 1,
    count: records.length,
    chunkCount: chunks.length,
    lastSyncAt: now,
    lastUpdatedAt: now,
    version: (oldMeta.version || 0) + 1,
    maxImportedAt: patch.maxImportedAt || (records[0] ? recSortKey(records[0]) : oldMeta.maxImportedAt) || oldMeta.maxImportedAt || '',
  };
  await kvPut(`meta-${season}`, JSON.stringify(meta));
  return meta;
}

async function fetchOfferbiuPage({ seasonYear, page, size, recruitTypes }) {
  const qs = new URLSearchParams();
  qs.set('seasonYear', String(seasonYear));
  qs.set('page', String(page));
  qs.set('size', String(size));
  if (recruitTypes && recruitTypes.length) qs.set('recruitType', recruitTypes.join(','));
  const data = await fetchOfferbiu(`/api/recruitment/postings?${qs.toString()}`);
  const d = data.data || {};
  return {
    items: Array.isArray(d.items) ? d.items : [],
    totalItems: Number(d.totalItems) || 0,
    totalPages: Number(d.totalPages) || 0,
  };
}

// —— 增量收集（顶部开始，importedAt > 水位线才收）——
async function incrementalCollect(season, maxImportedAt) {
  const fresh = [];
  for (let p = 0; p < MAX_INC_PAGES; p++) {
    let page;
    try {
      page = await fetchOfferbiuPage({ seasonYear: season, page: p, size: PAGE_SIZE, recruitTypes: null });
    } catch (e) {
      if (e.status === 403 || e.status === 429) break; // 上游限流/防深翻页：保留已收部分
      throw e;
    }
    const nf = page.items.filter((it) => recSortKey(it) > maxImportedAt);
    fresh.push(...nf);
    if (nf.length === 0 || page.items.length === 0) break; // 整页皆旧 → 已追上水位线
  }
  return fresh;
}

// —— 增量同步（懒更新核心；先抢锁）——
async function lazySync(season) {
  const lockKey = `lock-${season}`;
  const lockTs = Number(await kvGetText(lockKey)) || 0;
  if (lockTs && Date.now() - lockTs < LOCK_TTL_MS) return { skipped: true, reason: 'locked' };
  await kvPut(lockKey, String(Date.now()));
  try {
    const meta = await readMeta(season);
    if (!meta.ready) return { skipped: true, reason: 'not-ready' };
    const fresh = await incrementalCollect(season, meta.maxImportedAt || '');
    if (!fresh.length) {
      // 无新数据：只刷新同步时间，避免每 30 分钟都白探
      await kvPut(`meta-${season}`, JSON.stringify({ ...meta, lastSyncAt: Date.now() }));
      return { changed: 0 };
    }
    const { records: existing } = await readAllRecords(season);
    const byId = new Map((Array.isArray(existing) ? existing : []).map((r) => [r.id, r]));
    let newCount = 0;
    for (const r of fresh) {
      if (!byId.has(r.id)) newCount++;
      byId.set(r.id, r); // 已存在 id 用新版覆盖
    }
    const merged = sortRecords([...byId.values()]);
    await writeAllRecords(season, merged, { lastNewCount: newCount });
    return { changed: newCount, total: merged.length };
  } finally {
    await kvDel(lockKey);
  }
}

// —— 离线过滤 + 分页（复刻 offerbiu 列表语义）——
function buildOfflineResponse(records, url) {
  const q = (url.searchParams.get('q') || '').trim();
  const rts = (url.searchParams.get('recruitType') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const targetYear = (url.searchParams.get('targetYear') || '').trim();
  let page = parseInt(url.searchParams.get('page') || '0', 10);
  if (!Number.isFinite(page) || page < 0) page = 0;
  let size = parseInt(url.searchParams.get('size') || '20', 10);
  if (!Number.isFinite(size) || size <= 0) size = 20;
  if (size > 100) size = 100;

  let list = records;
  if (rts.length) {
    const set = new Set(rts);
    list = list.filter((r) => set.has(r.recruitType)); // 精确 OR
  }
  if (targetYear) {
    const ty = Number(targetYear);
    if (Number.isFinite(ty)) list = list.filter((r) => Array.isArray(r.targetYears) && r.targetYears.includes(ty));
  }
  if (q) {
    const kw = q.toLowerCase();
    list = list.filter((r) =>
      String(r.companyName || '').toLowerCase().includes(kw) ||
      String(r.positionsText || '').toLowerCase().includes(kw));
  }
  const totalItems = list.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / size));
  return {
    success: true,
    code: 0,
    message: 'success',
    data: {
      items: list.slice(page * size, page * size + size),
      page,
      size,
      totalItems,
      totalPages,
      previewLimited: false,
      searchBackend: 'kv',
    },
  };
}

// —— 管理端点：/api/sync ——
async function handleSync(url) {
  const season = (url.searchParams.get('season') || '').trim();
  if ((url.searchParams.get('key') || '') !== SYNC_KEY) return json({ error: 'unauthorized' }, 403);
  if (!/^\d{4}$/.test(season)) return json({ error: 'bad season' }, 400);
  const wantStatus = url.searchParams.get('status') === '1';
  const wantFinal = url.searchParams.get('final') === '1';
  const fromRaw = url.searchParams.get('from');
  const toRaw = url.searchParams.get('to');
  const wantRefresh = url.searchParams.get('mode') === 'refresh' || (!wantStatus && !wantFinal && fromRaw == null);

  if (wantStatus) {
    const meta = await readMeta(season);
    return json({ ok: true, season, ready: meta.ready === 1, meta });
  }

  // 预热分批：拉 from..to 页 → stage-{season}-{from}
  if (fromRaw != null && toRaw != null) {
    const from = Math.max(0, parseInt(fromRaw, 10) || 0);
    const to = Math.max(from, parseInt(toRaw, 10) || 0);
    if (to - from > 24) return json({ error: '单批最多 24 页' }, 400);
    const lockKey = `lock-${season}`;
    const lockTs = Number(await kvGetText(lockKey)) || 0;
    if (lockTs && Date.now() - lockTs < LOCK_TTL_MS) return json({ error: 'locked', retryLater: true }, 409);
    await kvPut(lockKey, String(Date.now()));
    try {
      const items = [];
      let totalItems = 0;
      for (let p = from; p <= to; p++) {
        const pg = await fetchOfferbiuPage({ seasonYear: season, page: p, size: PAGE_SIZE, recruitTypes: RECRUIT_TYPES_FULL });
        items.push(...pg.items);
        totalItems = pg.totalItems;
      }
      await kvPut(`stage-${season}-${from}`, JSON.stringify(items));
      const meta = await readMeta(season);
      const staged = meta.staged || [];
      if (!staged.includes(from)) staged.push(from);
      await kvPut(`meta-${season}`, JSON.stringify({ ...meta, staged }));
      return json({ ok: true, season, from, to, pages: to - from + 1, got: items.length, totalItems });
    } finally {
      await kvDel(lockKey);
    }
  }

  // 预热收尾：聚合全部 stage → 建 data + 置 ready
  if (wantFinal) {
    const meta = await readMeta(season);
    const staged = meta.staged || [];
    if (!staged.length) return json({ error: '没有可收尾的 stage 批次，先分批 from/to 拉取' }, 400);
    const lockKey = `lock-${season}`;
    const lockTs = Number(await kvGetText(lockKey)) || 0;
    if (lockTs && Date.now() - lockTs < LOCK_TTL_MS) return json({ error: 'locked', retryLater: true }, 409);
    await kvPut(lockKey, String(Date.now()));
    try {
      const parts = [];
      for (const from of staged) {
        const txt = await kvGetText(`stage-${season}-${from}`);
        if (txt) parts.push(...JSON.parse(txt));
      }
      const byId = new Map(parts.map((r) => [r.id, r]));
      const records = sortRecords([...byId.values()]);
      await writeAllRecords(season, records, { staged: [], lastNewCount: records.length });
      for (const from of staged) await kvDel(`stage-${season}-${from}`);
      return json({ ok: true, season, built: records.length, ready: true });
    } finally {
      await kvDel(lockKey);
    }
  }

  // 强制增量刷新
  if (wantRefresh) {
    const result = await lazySync(season);
    const meta = await readMeta(season);
    return json({
      ok: true, season, ...result,
      meta: { ready: meta.ready, count: meta.count, chunkCount: meta.chunkCount, maxImportedAt: meta.maxImportedAt, lastSyncAt: meta.lastSyncAt },
    });
  }
  return json({ error: '未知模式' }, 400);
}

// —— filter-options：KV 缓存（独立 TTL），miss 才打上游 ——
async function handleFilterOptions(url) {
  const season = (url.searchParams.get('seasonYear') || '').trim();
  if (!/^\d{4}$/.test(season)) return json({ error: 'bad seasonYear' }, 400);
  const key = `opt-${season}`;
  const cached = await kvGetText(key);
  if (cached) {
    try {
      const c = JSON.parse(cached);
      if (Date.now() - (c._at || 0) < OPT_TTL_MS) {
        const { _at, _body, ...rest } = c;
        return json(_body || rest, 200, { 'X-Cache': 'HIT' });
      }
    } catch { /* fallthrough */ }
  }
  try {
    const upstream = await fetchOfferbiu(`/api/recruitment/filter-options?seasonYear=${season}`);
    await kvPut(key, JSON.stringify({ _at: Date.now(), _body: upstream }));
    return json(upstream, 200, { 'X-Cache': 'MISS' });
  } catch (e) {
    if (cached) {
      try { return json(JSON.parse(cached)._body, 200, { 'X-Cache': 'STALE' }); } catch { /* fallthrough */ }
    }
    return json({ error: '上游不可达', detail: e.message }, 502);
  }
}

// —— postings：懒缓存读路径 ——
async function handlePostings(url) {
  const season = (url.searchParams.get('seasonYear') || '2027').trim();
  if (!/^\d{4}$/.test(season)) return json({ error: 'bad seasonYear' }, 400);

  const first = await readAllRecords(season);
  if (!first.records) {
    // 冷启动过渡期（未 ready）：直连透传，与旧版纯代理行为一致
    const resp = await fetch(`${UPSTREAM}/api/recruitment/postings${url.search}`, { headers: UPSTREAM_HEADERS });
    const text = await resp.text();
    return new Response(text, {
      status: resp.status,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'X-Cache': 'UPSTREAM',
      },
    });
  }

  // 过期则顺手增量刷新（失败不阻塞，继续用现有缓存）
  let tag = 'HIT';
  if (Date.now() - (first.meta.lastSyncAt || 0) > SYNC_TTL_MS) {
    try {
      const r = await lazySync(season);
      tag = r && r.changed ? 'SYNCED' : r && r.skipped ? 'HIT' : 'HIT';
    } catch { tag = 'HIT'; }
  }
  const { records: latest } = await readAllRecords(season);
  return json(buildOfflineResponse(latest || first.records, url), 200, { 'X-Cache': tag });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    // 静态资源与 favicon 原样放行
    if (!p.startsWith('/api/')) return fetch(request);
    try {
      if (p === '/api/sync') return await handleSync(url);
      if (p === '/api/recruitment/postings') return await handlePostings(url);
      if (p === '/api/recruitment/filter-options') return await handleFilterOptions(url);
      // 其余 /api/* 保持透传兜底
      const resp = await fetch(`${UPSTREAM}${p}${url.search}`, { headers: UPSTREAM_HEADERS });
      const text = await resp.text();
      return new Response(text, {
        status: resp.status,
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        },
      });
    } catch (err) {
      return json({ error: '网关错误', detail: err.message }, 502);
    }
  },
};
