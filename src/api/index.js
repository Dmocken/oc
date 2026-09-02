const API_PREFIX = '/api';

let authRedirecting = false;

/**
 * 会话失效（边缘函数返回 401）时前往登录页。
 * 这里必须"导航到 /api/login"而不是 reload 当前页：
 * 若首页 HTML 被浏览器缓存，reload 会直接使用本地缓存、不再经过边缘函数，
 * 于是 JS 再次请求接口 → 再次 401 → 无限刷新，且永远看不到登录页。
 * 而 /api/login 不是静态资源路径，必定由边缘函数处理并返回登录页。
 * 数据出口始终由服务端强制鉴权，前端只负责把用户送到登录入口。
 */
function handleUnauthorized() {
  if (typeof window === 'undefined' || typeof window.location?.replace !== 'function') return;
  if (authRedirecting) return; // 并发多个 401 时只导航一次
  authRedirecting = true;
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.replace(`/api/login?next=${next}`);
}

/**
 * filter-options 拉取失败时兜底的招聘类型全集（2026/2027 两季并集），
 * 用于「不限招聘类型」时向服务端传全集以解锁深翻页，同时保证不丢数据。
 */
export const FALLBACK_RECRUIT_TYPES = [
  '26届提前批', '春招', '春招补录', '春招专场', '春招提前批',
  '寒假实习', '秋招', '秋招补录', '秋招提前批', '秋招专场',
  '日常实习', '人才计划', '社招', '暑期实习', '提前批',
  '夏招', '实习', '实习生', '未分类', '校招',
];

/**
 * 将 offerbiu 招聘条目归一化为上层组件通用的行数据
 */
export function mapPosting(item) {
  const targetYears = Array.isArray(item.targetYears) ? item.targetYears : [];
  return {
    id: item.id,
    name: item.companyName || '未命名公司',
    type: item.companyNature || '',
    industry: item.industry || '',
    recruitment_type: item.recruitType || '',
    target_candidates: targetYears.length
      ? targetYears.map((y) => `${y}届`).join('、')
      : '',
    positions: item.positionsText || '',
    locations: Array.isArray(item.locations) ? item.locations : [],
    deadline: item.deadlineAt || null,
    deadline_text: item.deadlineText || '',
    update_time: item.sourceUpdatedAt || item.updatedAt || null,
    progress_status: '',
    company_size: '',
    apply_url: item.applyUrl || '',
    raw: item,
  };
}

/**
 * 拉取指定招聘季的筛选选项
 * @returns {Promise<{recruitTypes:string[], targetYears:number[], industries:string[], industryGroups:object[]}>}
 */
export async function fetchFilterOptions(seasonYear) {
  const resp = await fetch(`${API_PREFIX}/recruitment/filter-options?seasonYear=${encodeURIComponent(seasonYear)}`);
  if (resp.status === 401) handleUnauthorized(); // 会话失效 → 回到登录页
  if (!resp.ok) {
    const error = new Error(`筛选选项请求失败: ${resp.status} ${resp.statusText}`);
    error.status = resp.status;
    throw error;
  }
  const body = await resp.json();
  if (!body || body.success === false) {
    throw new Error(body?.message || '获取筛选选项失败');
  }
  return body.data || {};
}

/**
 * 服务端分页拉取 offerbiu 招聘记录
 *
 * @param {object} params
 * @param {string|number} [params.season_year='2027'] 求职季（届别），如 2027
 * @param {string} [params.search='']                 关键词 q（公司名/岗位）
 * @param {string[]} [params.recruitment_type=[]]     招聘类型（服务端精确 OR）
 * @param {string} [params.target_year='']            目标届别（单值）
 * @param {number} [params.page=1]                    页码（1 基）
 * @param {number} [params.per_page=20]               每页条数（≤100）
 * @param {string[]} [params.unlockRecruitTypes=[]]   不限招聘类型时携带的全集（用于解锁深翻页）
 */
export async function fetchCompanies({
  season_year = '2027',
  search = '',
  recruitment_type = [],
  target_year = '',
  page = 1,
  per_page = 20,
  unlockRecruitTypes = [],
} = {}) {
  const qs = new URLSearchParams();
  qs.set('seasonYear', String(season_year));
  qs.set('page', String(Math.max(0, Number(page) - 1)));
  qs.set('size', String(per_page));

  const keyword = String(search || '').trim();
  if (keyword) qs.set('q', keyword);

  if (target_year) qs.set('targetYear', String(target_year));

  // 招聘类型：选了就精确传；没选则传全集（并集 = 该季全部记录，同时规避无筛选时的深翻页限制）
  const recruitTypes =
    Array.isArray(recruitment_type) && recruitment_type.length
      ? recruitment_type
      : Array.isArray(unlockRecruitTypes) && unlockRecruitTypes.length
        ? unlockRecruitTypes
        : FALLBACK_RECRUIT_TYPES;
  if (recruitTypes.length) qs.set('recruitType', recruitTypes.join(','));

  const resp = await fetch(`${API_PREFIX}/recruitment/postings?${qs.toString()}`);
  if (resp.status === 401) handleUnauthorized(); // 会话失效 → 回到登录页
  if (!resp.ok) {
    const error = new Error(`请求失败: ${resp.status} ${resp.statusText}`);
    error.status = resp.status;
    throw error;
  }
  const body = await resp.json();
  if (!body || body.success === false) {
    const error = new Error(body?.message || '获取数据失败');
    error.status = 500;
    throw error;
  }

  const d = body.data || {};
  const items = Array.isArray(d.items) ? d.items : [];
  const totalItems = Number(d.totalItems) || 0;
  const pageIndex = Number(d.page) || 0;
  const totalPages =
    Number(d.totalPages) || (Number(d.size) > 0 ? Math.max(1, Math.ceil(totalItems / Number(d.size))) : 1);

  return {
    data: items.map(mapPosting),
    pagination: {
      current_page: pageIndex + 1,
      per_page: Number(d.size) || Number(per_page),
      total_items: totalItems,
      total_pages: totalPages,
    },
  };
}
