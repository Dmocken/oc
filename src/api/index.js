// 走 Vite 代理避免跨域（开发环境），生产构建时替换为完整 URL
const BASE_URL = '/wp-json/givemeoc/v1/companies';

/**
 * 获取公司列表（支持筛选、分页、排序）
 */
export async function fetchCompanies({
  search = '',
  company_type = '',
  recruitment_type = '',
  progress_status = '',
  target_candidates = '',
  page = 1,
  per_page = 20,
  order_by = 'update_time',
  order = 'desc',
} = {}) {
  const params = { page, per_page, order_by, order };
  if (search) params.search = search;
  if (company_type) params.company_type = company_type;
  if (recruitment_type) params.recruitment_type = recruitment_type;
  if (progress_status) params.progress_status = progress_status;
  if (target_candidates) params.target_candidates = target_candidates;

  const resp = await fetch(
    `${BASE_URL}?${new URLSearchParams(params).toString()}`
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

  // 先请求第一页，获取总页数
  const firstResult = await fetchCompanies({ ...filters, page: 1, per_page });
  allRows.push(...firstResult.data);

  const totalPages = firstResult.pagination?.total_pages || 1;

  // 并发请求剩余页（控制并发数避免被限流）
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
