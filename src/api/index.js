const BASE_URL = import.meta.env.VITE_API_BASE_URL;

/**
 * 获取公司列表（支持筛选、分页、排序）
 * 多选字段传数组 → 拼接为 key[]=val1&key[]=val2
 */
export async function fetchCompanies({
  search = '',
  company_type = [],
  recruitment_type = [],
  progress_status = [],
  target_candidates = [],
  page = 1,
  per_page = 20,
  order_by = 'update_time',
  order = 'desc',
} = {}) {
  const usp = new URLSearchParams();
  usp.set('page', page);
  usp.set('per_page', per_page);
  usp.set('order_by', order_by);
  usp.set('order', order);

  if (search) usp.set('search', search);

  const appendArr = (key, arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return;
    arr.forEach((v) => usp.append(`${key}[]`, v));
  };
  appendArr('company_type', company_type);
  appendArr('recruitment_type', recruitment_type);
  appendArr('progress_status', progress_status);
  appendArr('target_candidates', target_candidates);

  const resp = await fetch(
    `${BASE_URL}?${usp.toString()}`
  );
  if (!resp.ok) {
    const error = new Error(`请求失败: ${resp.status} ${resp.statusText}`);
    error.status = resp.status;
    throw error;
  }
  return resp.json();
}

/**
 * 获取公司详情
 */
export async function fetchCompanyDetail(id) {
  const resp = await fetch(`${BASE_URL}/${id}`);
  if (!resp.ok) {
    throw new Error(`详情请求失败: ${resp.status} ${resp.statusText}`);
  }
  return resp.json();
}

/**
 * 获取单页数据（用于预加载/缓存）
 */
export async function fetchPage(page, per_page = 100) {
  return fetchCompanies({ page, per_page });
}

/**
 * 获取所有数据（多页合并），支持筛选条件
 */
export async function fetchAllCompanies(filters = {}) {
  const per_page = 100;
  const allRows = [];

  const firstResult = await fetchCompanies({ ...filters, page: 1, per_page });
  allRows.push(...firstResult.data);

  const totalPages = firstResult.pagination?.total_pages || 1;

  const CONCURRENCY = 4;
  for (let start = 2; start <= totalPages; start += CONCURRENCY) {
    const batch = [];
    for (let p = start; p < start + CONCURRENCY && p <= totalPages; p++) {
      batch.push(fetchCompanies({ ...filters, page: p, per_page }));
    }
    const results = await Promise.all(batch);
    results.forEach((r) => allRows.push(...r.data));
  }

  return allRows;
}
