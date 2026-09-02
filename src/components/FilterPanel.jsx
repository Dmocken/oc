import { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { FALLBACK_RECRUIT_TYPES } from '../api';
import './FilterPanel.css';

const PROGRESS_STATUSES = ['', '未投递', '已投递', '笔试中', '面试中', '已发offer', '已拒', '已过期'];
const PER_PAGE_OPTIONS = [20, 50, 100];
const SEASON_OPTIONS = [
  { value: '2027', label: '2027届' },
  { value: '2026', label: '2026届' },
];

export default function FilterPanel({
  filters,
  onFilterChange,
  onSearch,
  loading,
  filterOptions,
  companyTypeOptions,
}) {
  const [localSearch, setLocalSearch] = useState(filters.search || '');

  useEffect(() => setLocalSearch(filters.search || ''), [filters.search]);

  const recruitTypes =
    filterOptions?.recruitTypes?.length
      ? filterOptions.recruitTypes
      : FALLBACK_RECRUIT_TYPES;

  const targetYears =
    filterOptions?.targetYears?.length
      ? [...filterOptions.targetYears].sort((a, b) => b - a)
      : [];

  const handleSingle = (key, value) => onFilterChange({ ...filters, [key]: value, page: 1 });
  const handleMulti = (key, value) => {
    // value 是新数组；若包含 ''（全部），清空为 []
    const cleaned = value.includes('') ? [] : value;
    onFilterChange({ ...filters, [key]: cleaned, page: 1 });
  };

  const handleSeason = (value) => {
    if (String(value) === String(filters.season_year)) return;
    // 切换求职季后，届别相关的筛选重置为不限
    onFilterChange({
      ...filters,
      season_year: value,
      recruitment_type: [],
      target_year: '',
      page: 1,
    });
  };

  return (
    <section className="filter-panel" aria-label="筛选和搜索">
      <div className="filter-toolbar">
        <form className="filter-search" onSubmit={(e) => { e.preventDefault(); onSearch(localSearch); }}>
          <label className="search-wrap">
            <span className="search-icon" aria-hidden="true">
              <svg clip-rule="evenodd" fill-rule="evenodd" stroke-linejoin="round" stroke-miterlimit="2" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="m15.97 17.031c-1.479 1.238-3.384 1.985-5.461 1.985-4.697 0-8.509-3.812-8.509-8.508s3.812-8.508 8.509-8.508c4.695 0 8.508 3.812 8.508 8.508 0 2.078-.747 3.984-1.985 5.461l4.749 4.75c.146.146.219.338.219.531 0 .587-.537.75-.75.75-.192 0-.384-.073-.531-.22zm-5.461-13.53c-3.868 0-7.007 3.14-7.007 7.007s3.139 7.007 7.007 7.007c3.866 0 7.007-3.14 7.007-7.007s-3.141-7.007-7.007-7.007z" fill-rule="nonzero"/></svg>
            </span>
            <input
              type="search"
              className="search-input"
              placeholder="搜索公司名称或岗位..."
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              aria-label="搜索公司名称或岗位"
            />
            {localSearch && <button type="button" className="search-clear" onClick={() => setLocalSearch('')} aria-label="清除关键词">×</button>}
          </label>
          <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? '加载中...' : '搜索'}</button>
        </form>

        <div className="season-area">
          <span className="season-label">求职季</span>
          <div className="season-switch" role="group" aria-label="选择求职季">
            {SEASON_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`season-option ${String(filters.season_year) === opt.value ? 'active' : ''}`}
                onClick={() => handleSeason(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="filter-row">
        <FilterSelect multi label="公司类型" value={filters.company_type} onChange={(v) => handleMulti('company_type', v)} options={companyTypeOptions} empty="全部类型" />
        <FilterSelect multi label="招聘类型" value={filters.recruitment_type} onChange={(v) => handleMulti('recruitment_type', v)} options={recruitTypes} empty="全部类型" />
        <FilterSelect
          label="目标届别"
          value={filters.target_year || ''}
          onChange={(v) => handleSingle('target_year', v)}
          options={['', ...targetYears.map(String)]}
          optionLabels={['全部届别', ...targetYears.map((y) => `${y}届`)]}
          empty="全部届别"
        />
        <FilterSelect multi label="投递状态" value={filters.progress_status} onChange={(v) => handleMulti('progress_status', v)} options={PROGRESS_STATUSES} empty="全部状态" />
        <FilterSelect
          label="每页数量"
          value={String(filters.per_page || 20)}
          onChange={(v) => handleSingle('per_page', Number(v))}
          options={PER_PAGE_OPTIONS.map(String)}
          optionLabels={PER_PAGE_OPTIONS.map((n) => `${n} 条`)}
        />
      </div>
    </section>
  );
}

function FilterSelect({ label, value, onChange, options, empty, optionLabels, multi }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });
  const triggerRef = useRef(null);
  const dropdownRef = useRef(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target) &&
        triggerRef.current && !triggerRef.current.contains(e.target)
      ) {
        close();
      }
    };
    const scrollHandler = (e) => {
      if (dropdownRef.current && dropdownRef.current.contains(e.target)) return;
      close();
    };
    document.addEventListener('mousedown', handler);
    window.addEventListener('scroll', scrollHandler, true);
    return () => {
      document.removeEventListener('mousedown', handler);
      window.removeEventListener('scroll', scrollHandler, true);
    };
  }, [open, close]);

  const handleToggle = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
    setOpen((v) => !v);
  };

  // --- multi-select logic ---
  if (multi) {
    const selected = Array.isArray(value) ? value : [];
    const isAll = selected.length === 0;

    const getLabel = () => {
      if (isAll) return empty;
      const labels = selected
        .map((v) => optionLabels ? optionLabels[options.indexOf(v)] : (v || empty))
        .filter(Boolean);
      if (labels.length <= 2) return labels.join('、');
      return `${labels[0]} +${labels.length - 1}`;
    };

    const hasValue = !isAll;

    const handleSelect = (option) => {
      let next;
      if (option === '') {
        next = []; // 全部 → 清空
      } else if (selected.includes(option)) {
        next = selected.filter((v) => v !== option);
      } else {
        next = [...selected, option];
      }
      onChange(next);
    };

    return (
      <div className="filter-item">
        <span>{label}</span>
        <button
          ref={triggerRef}
          type="button"
          className={`filter-trigger ${open ? 'open' : ''} ${hasValue ? 'has-value' : ''}`}
          onClick={handleToggle}
        >
          <span className="filter-trigger-text">{getLabel()}</span>
          {hasValue && <span className="filter-trigger-count">{selected.length}</span>}
          <span className="filter-trigger-arrow" aria-hidden="true" />
        </button>
        {open &&
          createPortal(
            <div className="filter-dropdown-overlay" onClick={close}>
              <div
                ref={dropdownRef}
                className="filter-dropdown"
                style={{ top: pos.top, left: pos.left, minWidth: pos.width }}
                onClick={(e) => e.stopPropagation()}
              >
                {options.map((option, index) => {
                  const lbl = optionLabels?.[index] || option || empty;
                  const sel = option === '' ? isAll : selected.includes(option);
                  return (
                    <button
                      key={option}
                      type="button"
                      className={`filter-dropdown-item ${sel ? 'active' : ''}`}
                      onClick={() => handleSelect(option)}
                    >
                      <span className="filter-dropdown-label">{lbl}</span>
                      <span className={`filter-dropdown-checkbox ${sel ? 'checked' : ''}`}>
                        {sel && <span className="filter-dropdown-checkmark" />}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>,
            document.body
          )}
      </div>
    );
  }

  // --- single-select logic ---
  const selectedLabel = optionLabels
    ? optionLabels[options.indexOf(value)] || empty
    : (options.find((o) => o === value) || empty || value);

  const handleSingleSelect = (option) => {
    onChange(option);
    close();
  };

  return (
    <div className="filter-item">
      <span>{label}</span>
      <button
        ref={triggerRef}
        type="button"
        className={`filter-trigger ${open ? 'open' : ''} ${value ? 'has-value' : ''}`}
        onClick={handleToggle}
      >
        <span className="filter-trigger-text">{selectedLabel}</span>
        <span className="filter-trigger-arrow" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div className="filter-dropdown-overlay" onClick={close}>
            <div
              ref={dropdownRef}
              className="filter-dropdown"
              style={{ top: pos.top, left: pos.left, minWidth: pos.width }}
              onClick={(e) => e.stopPropagation()}
            >
              {options.map((option, index) => {
                const label = optionLabels?.[index] || option || empty;
                const isSelected = option === value;
                return (
                  <button
                    key={option}
                    type="button"
                    className={`filter-dropdown-item ${isSelected ? 'active' : ''}`}
                    onClick={() => handleSingleSelect(option)}
                  >
                    <span className="filter-dropdown-label">{label}</span>
                    {isSelected && <span className="filter-dropdown-check">✓</span>}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
