// 冷启动预热脚本：把某求职季的 offerbiu 全量记录写入边缘 KV。
//
// 用法：
//   node scripts/prewarm.mjs <部署域名> [season=2027] [syncKey]
// 例：
//   node scripts/prewarm.mjs https://jobs.example.com 2027 oc-sync-2026a9f3c7e2
//
// 原理：管理端点 /api/sync 受边缘函数单请求能力约束，按页分多批抓取，
//       每批写独立 stage key（无读改写竞争，弱一致安全），最后 final 一次性聚合成 data。
//       脚本幂等：已完成的批次（meta.staged）会跳过，中断后重跑即可续传。
//       预热完成前站点对外是直连透传（旧行为），可随时上线、随时补全。
const PAGE = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const resp = await fetch(url);
      const body = await resp.json();
      if (resp.ok) return body;
      if (resp.status === 409) {
        console.error(`  [${i}/${tries}] 忙(他人同步中)，1s 后重试`);
        await sleep(1000);
        continue;
      }
      console.error(`  [${i}/${tries}] HTTP ${resp.status}: ${JSON.stringify(body).slice(0, 200)}`);
    } catch (e) {
      console.error(`  [${i}/${tries}] 请求失败: ${e.message}`);
    }
    await sleep(500);
  }
  throw new Error('重试耗尽，请稍后重新运行脚本（已完成批次会跳过）');
}

function rangeLabel(a, b) {
  return `${String(a).padStart(2, '0')}~${String(b).padStart(2, '0')}`;
}

async function main() {
  const [, , baseArg, seasonArg, keyArg] = process.argv;
  const BASE = (baseArg || '').replace(/\/+$/, '');
  const SEASON = seasonArg || '2027';
  const KEY = keyArg || 'oc-sync-2026a9f3c7e2';
  if (!BASE) {
    console.error('用法: node scripts/prewarm.mjs <部署域名> [season=2027] [syncKey]');
    console.error('例:   node scripts/prewarm.mjs https://jobs.example.com 2027 my-secret');
    process.exit(2);
  }
  const U = (qs) => `${BASE}/api/sync?season=${SEASON}&key=${KEY}${qs}`;

  console.log(`[*] 预热 season=${SEASON} @ ${BASE}`);
  const st = await getJson(U('&status=1'));
  console.log(`[*] 当前状态 ready=${st.ready} count=${st.meta?.count} 已完成批次=${JSON.stringify(st.meta?.staged || [])}`);
  const done = new Set(st.meta?.staged || []);

  // 第一批同时用于探测总页数
  let totalPages;
  if (done.has(0)) {
    const full = await getJson(U('&status=1'));
    totalPages = full.meta?.count ? Math.ceil(full.meta.count / PAGE) : 0;
  } else {
    const first = await getJson(U('&from=0&to=0'));
    totalPages = Math.max(1, Math.ceil((first.totalItems || 0) / PAGE));
    done.add(0);
    console.log(`[√] 批次 ${rangeLabel(0, 0)}: ${first.got} 条(上游共 ${first.totalItems} 条 → ${totalPages} 页)`);
  }
  if (!totalPages) {
    console.error('[*] 无法确定页数，退出');
    process.exit(1);
  }

  // 其余页按 8 页一批
  for (let from = 1; from < totalPages; from += 8) {
    const to = Math.min(from + 7, totalPages - 1);
    if (done.has(from)) {
      console.log(`[·] 跳过已完成批次 ${rangeLabel(from, to)}`);
      continue;
    }
    const r = await getJson(U(`&from=${from}&to=${to}`));
    console.log(`[√] 批次 ${rangeLabel(from, to)}: ${r.got} 条`);
    await sleep(300); // 节奏放缓，避免触发上游限流
  }

  // 收尾聚合
  const fin = await getJson(U('&final=1'));
  console.log(`[√] final: 建库 ${fin.built} 条`);
  const ver = await getJson(U('&status=1'));
  console.log(`[√] 状态 ready=${ver.ready} count=${ver.meta.count} chunk=${ver.meta.chunkCount} maxImportedAt=${ver.meta.maxImportedAt}`);
  if (ver.meta.count !== fin.built) {
    console.warn(`[!] 数量不一致(count=${ver.meta.count} vs built=${fin.built})，请用 status=1 复查`);
  } else {
    console.log('[√] 预热完成。后续日常更新由「用户访问时懒增量」自动维护，无需再手动跑本脚本。');
  }
}

main().catch((e) => {
  console.error('[*] 预热失败:', e.message);
  process.exit(1);
});
