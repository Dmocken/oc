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

// —— 访问鉴权：验证器 App 的 TOTP 动态口令（RFC 6238，6 位 / 30 秒）——
// 密钥（Base32）不写在代码里，由函数变量注入：
//   控制台 → 边缘计算和 AI → 函数和Pages → 目标函数 → 基本信息 → 函数变量
//   添加变量：键 TOTP_SECRET，值为 Base32 密钥（建议勾选「加密存储」）
//   注意：新增/修改变量后需重新部署版本才会生效；未配置时站点拒绝一切访问（fail-closed）。
// 密钥可用 node scripts/setup-totp.mjs 生成，并用验证器 App 扫码或手输录入。
const AUTH_COOKIE = 'oc_auth';
const AUTH_MAX_AGE = 30 * 24 * 3600; // 会话有效期 30 天
const TOTP_PERIOD = 30; // 时间步长（秒），与验证器 App 一致
const TOTP_DIGITS = 6;
const TOTP_SKEW = 1; // 容忍 ±1 个时间窗，抵消时钟漂移
const OTP_REPLAY_GUARD_MS = 90 * 1000; // 同一个动态口令在此窗口内只能成功一次

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

// —— 常量时间比较（避免计时侧信道）——
function safeEqual(a, b) {
  const x = String(a == null ? '' : a);
  const y = String(b == null ? '' : b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// —— TOTP（RFC 6238）——
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  const s = String(input || '').toUpperCase().replace(/[=\s-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) return null; // 非法字符 → 视为未配置
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function hmacSha1(keyBytes, msgBytes) {
  try {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, msgBytes));
  } catch {
    // 回退：运行时若不支持 Web Crypto 的 HMAC-SHA1，改用 Node 兼容的 crypto 模块
    const { createHmac } = await import('node:crypto');
    return new Uint8Array(createHmac('sha1', Buffer.from(keyBytes)).update(Buffer.from(msgBytes)).digest());
  }
}

function counterBytes(counter) {
  const b = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    b[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  return b;
}

async function hotpAt(secretBytes, counter) {
  const mac = await hmacSha1(secretBytes, counterBytes(counter));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % Math.pow(10, TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}

// 校验输入口令，容忍 ±TOTP_SKEW 个时间窗（atSeconds 便于测试与时钟校正）
async function verifyTotp(secretBytes, input, atSeconds) {
  const code = String(input == null ? '' : input).replace(/\D/g, '');
  if (code.length !== TOTP_DIGITS) return false;
  const now = atSeconds == null ? Math.floor(Date.now() / 1000) : atSeconds;
  const base = Math.floor(now / TOTP_PERIOD);
  for (let d = -TOTP_SKEW; d <= TOTP_SKEW; d++) {
    if (safeEqual(code, await hotpAt(secretBytes, base + d))) return true;
  }
  return false;
}

// 会话凭据：由密钥派生，泄露密钥才能伪造，且不含明文口令
async function sessionToken(secretBytes) {
  const mac = await hmacSha1(secretBytes, new TextEncoder().encode('oc-session-v1'));
  return Array.from(mac).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function getSecretBytes(env) {
  const raw = env && env.TOTP_SECRET;
  if (!raw) return null;
  const bytes = base32Decode(raw);
  return bytes && bytes.length ? bytes : null;
}

function cookieValue(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

async function isAuthorized(request, env) {
  const secretBytes = getSecretBytes(env);
  if (!secretBytes) return false; // 未配置密钥 → 一律不通过（fail-closed）
  const c = cookieValue(request, AUTH_COOKIE);
  if (!c) return false;
  return safeEqual(c, await sessionToken(secretBytes));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function safeNext(v) {
  const s = String(v == null ? '' : v);
  if (!s.startsWith('/') || s.startsWith('//')) return '/'; // 防开放重定向
  return s;
}

function isStaticAsset(p) {
  return /\.(js|mjs|css|map|json|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|txt|webmanifest)$/i.test(p);
}

// —— 登录页（内联，无外部依赖）——
function loginPage(errMsg, next) {
  const err = errMsg ? `<p class="err">${escapeHtml(errMsg)}</p>` : '<p class="tip">请输入验证器 App 上的 6 位动态口令</p>';
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>GiveMeOC · 访问验证</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
         background:#f5f6f8; color:#1f2328; }
  @media (prefers-color-scheme: dark) { body { background:#15181d; color:#e6e8eb; } }
  .card { width: min(340px, calc(100vw - 40px)); padding: 32px 28px; border-radius: 14px;
          background:#fff; box-shadow: 0 8px 28px rgba(0,0,0,.10); text-align:center; }
  @media (prefers-color-scheme: dark) { .card { background:#1e2229; box-shadow: 0 8px 28px rgba(0,0,0,.45); } }
  h1 { margin:0 0 6px; font-size: 20px; letter-spacing:.5px; }
  .tip { margin:0 0 18px; font-size:13px; color:#6b7280; }
  .err { margin:0 0 18px; font-size:13px; color:#d92d20; }
  input { width:100%; box-sizing:border-box; padding:12px 14px; font-size:22px; letter-spacing:10px;
          text-align:center; border:1px solid #d0d5dd; border-radius:10px; background:transparent;
          color:inherit; outline:none; font-variant-numeric: tabular-nums; }
  input:focus { border-color:#3b82f6; box-shadow:0 0 0 3px rgba(59,130,246,.18); }
  button { margin-top:16px; width:100%; padding:11px; font-size:15px; border:0; border-radius:10px;
           background:#1f6feb; color:#fff; cursor:pointer; }
  button:hover { background:#1a5fd0; }
</style>
</head>
<body>
  <form class="card" method="post" action="/api/login">
    <h1>GiveMeOC</h1>
    ${err}
    <input type="text" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6"
           autocomplete="one-time-code" autofocus required placeholder="000000" aria-label="6 位动态口令">
    <input type="hidden" name="next" value="${escapeHtml(safeNext(next))}">
    <button type="submit">验 证</button>
  </form>
</body>
</html>`;
  return new Response(html, {
    status: errMsg ? 401 : 200,
    headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' },
  });
}

// —— 登录：校验 TOTP → 下发会话 Cookie ——
async function handleLogin(request, env) {
  const secretBytes = getSecretBytes(env);
  if (!secretBytes) return json({ error: '服务端未配置 TOTP_SECRET 函数变量' }, 500);

  let code = '';
  let next = '/';
  const ct = (request.headers.get('Content-Type') || '').toLowerCase();
  if (request.method === 'POST') {
    if (ct.includes('application/json')) {
      try {
        const b = await request.json();
        code = String(b.code == null ? b.password == null ? '' : b.password : b.code);
        next = safeNext(b.next);
      } catch { code = ''; }
    } else {
      try {
        const form = await request.formData();
        code = String(form.get('code') || '');
        next = safeNext(form.get('next'));
      } catch { code = ''; }
    }
  } else {
    const u = new URL(request.url);
    code = u.searchParams.get('code') || '';
    next = safeNext(u.searchParams.get('next'));
    if (!code) return loginPage('', next);
  }

  if (!(await verifyTotp(secretBytes, code))) {
    return loginPage('口令错误或已失效，请重新输入验证器上的 6 位数字', next);
  }

  // 防重放：同一个动态口令 90 秒内只能成功一次
  const guardKey = `otp-${code}`;
  const usedAt = Number(await kvGetText(guardKey)) || 0;
  if (usedAt && Date.now() - usedAt < OTP_REPLAY_GUARD_MS) {
    return loginPage('该口令已使用过，请等待验证器刷新后重试', next);
  }
  await kvPut(guardKey, String(Date.now()));

  const token = await sessionToken(secretBytes);
  return new Response(null, {
    status: 303,
    headers: {
      Location: next,
      'Set-Cookie': `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${AUTH_MAX_AGE}`,
      'Cache-Control': 'no-store',
    },
  });
}

function handleLogout() {
  return new Response(null, {
    status: 303,
    headers: {
      Location: '/',
      'Set-Cookie': `${AUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      'Cache-Control': 'no-store',
    },
  });
}

export default {
  async fetch(request, context, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    // 登录/登出入口始终可达，否则配错密钥就无法自救
    if (p === '/api/login') return await handleLogin(request, env);
    if (p === '/api/logout') return handleLogout();

    // 管理端点：靠 SYNC_KEY 独立鉴权，不依赖会话（便于命令行预热/重建）
    if (p === '/api/sync') {
      try {
        return await handleSync(url);
      } catch (err) {
        return json({ error: '同步失败', detail: err.message }, 502);
      }
    }

    // 未配置密钥 → 一律拒绝（fail-closed），杜绝"没配变量 = 没有门禁"
    if (!getSecretBytes(env)) {
      return json({ error: '服务端未配置 TOTP_SECRET 函数变量，站点已拒绝访问' }, 500);
    }

    // 鉴权闸门：数据出口(/api/*)一律拒，页面入口返回登录页，静态资源放行
    if (!(await isAuthorized(request, env))) {
      if (p.startsWith('/api/')) return json({ error: 'unauthorized' }, 401);
      if (!isStaticAsset(p)) return loginPage('', safeNext(p + (url.search || '')));
      return fetch(request);
    }

    try {
      if (p.startsWith('/api/')) {
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
      }
      return fetch(request); // 已授权：页面与静态资源
    } catch (err) {
      return json({ error: '网关错误', detail: err.message }, 502);
    }
  },
};
