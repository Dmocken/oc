import { useState, useCallback, useRef, useEffect } from 'react';
import { fetchCompanies } from './api';
import { getAllLocalStatuses } from './utils/localStatus';
import FilterPanel from './components/FilterPanel';
import DataTable from './components/DataTable';
import DetailModal from './components/DetailModal';
import './App.css';

const DEFAULT_FILTERS = {
  search: '',
  company_type: '',
  recruitment_type: '',
  progress_status: '',
  target_candidates: '',
  order_by: 'update_time',
  order: 'desc',
  page: 1,
  per_page: 20,
};

function matchesTargetCandidates(value, target) {
  if (!target) return true;
  const values = Array.isArray(value) ? value : String(value || '').split(/[、,，/|;；\s]+/);
  return values.some((item) => String(item).trim() === target);
}

export default function App() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [data, setData] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const requestId = useRef(0);
  const lastValidPage = useRef(1);
  const filtersRef = useRef(filters);

  filtersRef.current = filters;

  const loadData = useCallback(async (overrideFilters = null) => {
    const currentFilters = overrideFilters || filtersRef.current;
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      // 招聘类型和投递状态不传 API，前端做子串/本地匹配
      const result = await fetchCompanies({
        ...currentFilters,
        recruitment_type: '',
        progress_status: '',
      });
      if (currentRequest !== requestId.current) return;

      const localStatuses = getAllLocalStatuses();

      // 前端二次过滤：
      // 1. target_candidates 精确匹配
      // 2. recruitment_type 子串匹配（"提前批" 匹配 "秋招提前批"）
      // 3. progress_status 使用本地保存/覆盖的状态
      const rows = (result.data || []).filter((item) => {
        if (!matchesTargetCandidates(item.target_candidates, currentFilters.target_candidates)) return false;

        if (currentFilters.recruitment_type) {
          const rt = item.recruitment_type || '';
          if (!rt.includes(currentFilters.recruitment_type)) return false;
        }

        if (currentFilters.progress_status) {
          const localStatus = localStatuses[item.id] ?? item.progress_status ?? '';
          if (localStatus !== currentFilters.progress_status) return false;
        }

        return true;
      });

      setData(rows);
      setPagination(result.pagination || null);
      lastValidPage.current = Math.max(lastValidPage.current, Number(currentFilters.page) || 1);
    } catch (err) {
      if (currentRequest !== requestId.current) return;
      if (err.status === 400 && Number(currentFilters.page) > 1) {
        const fallbackPage = Math.max(1, Math.min(Number(currentFilters.page) - 1, lastValidPage.current));
        const restoredFilters = { ...currentFilters, page: fallbackPage };
        setFilters(restoredFilters);
        setPagination((previous) => previous ? {
          ...previous,
          current_page: fallbackPage,
          page: fallbackPage,
          total_pages: fallbackPage,
        } : previous);
        setError(null);
        return;
      }
      setError(err.message || '暂时无法获取数据');
      setData([]);
      setPagination(null);
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData(DEFAULT_FILTERS);
  }, [loadData]);

  const handleFilterChange = (newFilters) => {
    setFilters(newFilters);
    loadData(newFilters);
  };

  const handleSearch = (keyword) => {
    const newFilters = { ...filtersRef.current, search: keyword.trim(), page: 1 };
    setFilters(newFilters);
    loadData(newFilters);
  };

  const handlePageChange = (page) => {
    const newFilters = { ...filtersRef.current, page };
    setFilters(newFilters);
    loadData(newFilters);
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-content">
          <div className="brand-row">
            <h1>校园招聘记录追踪</h1>
          </div>
        </div>
      </header>

      <main className="app-main" aria-busy={loading}>
        <FilterPanel
          filters={filters}
          onFilterChange={handleFilterChange}
          onSearch={handleSearch}
          loading={loading}
        />

        {error && (
          <div className="error-banner" role="alert">
            <div><strong>数据加载失败</strong><span>{error}</span></div>
            <button onClick={() => loadData()}>重新加载</button>
          </div>
        )}

        <DataTable
          data={data}
          loading={loading}
          pagination={pagination}
          onPageChange={handlePageChange}
          onRowClick={setSelectedId}
        />
      </main>

      {selectedId && <DetailModal companyId={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}
