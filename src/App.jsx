import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { fetchCompanies, fetchFilterOptions, FALLBACK_RECRUIT_TYPES } from './api';
import { getAllLocalStatuses } from './utils/localStatus';
import FilterPanel from './components/FilterPanel';
import DataTable from './components/DataTable';
import DetailModal from './components/DetailModal';
import './App.css';

const DEFAULT_FILTERS = {
  season_year: '2027', // offerbiu 求职季（届别），2026/2027 可切换
  search: '',
  recruitment_type: [], // 服务端精确 OR
  target_year: '',      // 服务端目标届别（单值），'' = 不限
  company_type: [],     // 服务端不支持，前端过滤
  progress_status: [],  // 本地投递状态，前端过滤
  page: 1,
  per_page: 20,
};

// 前端「公司类型」筛选项基线（offerbiu companyNature 常见值，其余值按数据动态补充）
const BASE_COMPANY_TYPES = ['民企', '央国企', '外企', '事业单位', '银行', '中外合资'];

function hasFilter(arr) {
  return Array.isArray(arr) && arr.length > 0;
}

export default function App() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [filterOptions, setFilterOptions] = useState(null);
  const [data, setData] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedRow, setSelectedRow] = useState(null);

  const requestId = useRef(0);
  const filtersRef = useRef(filters);
  const optionsRef = useRef(null); // { season_year, recruitTypes }

  filtersRef.current = filters;

  const loadOptions = useCallback(async (seasonYear) => {
    try {
      const opts = await fetchFilterOptions(seasonYear);
      optionsRef.current = {
        season_year: String(seasonYear),
        recruitTypes: opts.recruitTypes?.length ? opts.recruitTypes : FALLBACK_RECRUIT_TYPES,
        targetYears: opts.targetYears || [],
      };
      if (String(filtersRef.current.season_year) === String(seasonYear)) {
        setFilterOptions(opts);
      }
    } catch {
      // 选项拉取失败不阻塞主流程，界面使用静态兜底
      optionsRef.current = null;
      setFilterOptions(null);
    }
  }, []);

  const loadData = useCallback(async (overrideFilters = null) => {
    const currentFilters = overrideFilters || filtersRef.current;
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      // 未选择招聘类型时，需要携带「全部招聘类型」并集：
      // 1) 语义上等于该季全部记录；2) 规避 offerbiu 对无筛选请求的深翻页限制
      const unlockRecruitTypes =
        optionsRef.current?.season_year === String(currentFilters.season_year)
          ? optionsRef.current.recruitTypes
          : FALLBACK_RECRUIT_TYPES;

      const result = await fetchCompanies({
        season_year: currentFilters.season_year,
        search: currentFilters.search,
        recruitment_type: currentFilters.recruitment_type,
        target_year: currentFilters.target_year,
        page: currentFilters.page,
        per_page: currentFilters.per_page,
        unlockRecruitTypes,
      });
      if (currentRequest !== requestId.current) return;

      const localStatuses = getAllLocalStatuses();

      // 服务端已按 招聘类型/目标届别/关键词 过滤，这里只做服务端不支持的本地过滤
      const rows = (result.data || []).filter((row) => {
        // 公司类型：子串匹配（"外企"能命中"外企/合资"等）
        if (hasFilter(currentFilters.company_type)) {
          const t = row.type || '';
          if (!currentFilters.company_type.some((c) => t.includes(c))) return false;
        }
        // 投递状态：本地覆盖优先
        if (hasFilter(currentFilters.progress_status)) {
          const st = localStatuses[row.id] ?? row.progress_status ?? '';
          if (!currentFilters.progress_status.includes(st)) return false;
        }
        return true;
      });

      setData(rows);
      setPagination(result.pagination || null);
    } catch (err) {
      if (currentRequest !== requestId.current) return;
      setError(err.message || '暂时无法获取数据');
      setData([]);
      setPagination(null);
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadOptions(DEFAULT_FILTERS.season_year);
    loadData(DEFAULT_FILTERS);
  }, [loadOptions, loadData]);

  const handleFilterChange = (newFilters) => {
    if (String(newFilters.season_year) !== String(filtersRef.current.season_year)) {
      // 切换求职季：清空旧季选项缓存，重新拉取
      optionsRef.current = null;
      setFilterOptions(null);
      loadOptions(newFilters.season_year);
    }
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

  const companyTypeOptions = useMemo(() => {
    const set = new Set(BASE_COMPANY_TYPES);
    data.forEach((row) => { if (row.type) set.add(row.type); });
    return Array.from(set);
  }, [data]);

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
          filterOptions={filterOptions}
          companyTypeOptions={companyTypeOptions}
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
          onRowClick={setSelectedRow}
        />
      </main>

      {selectedRow && <DetailModal row={selectedRow} onClose={() => setSelectedRow(null)} />}
    </div>
  );
}
