import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { getAllLocalStatuses, setLocalStatus } from '../utils/localStatus';
import './DataTable.css';

const ALL_STATUSES = ['未投递', '已投递', '笔试中', '面试中', '已发offer', '已拒', '已过期'];

const STATUS_COLORS = {
  '未投递': '#9ca3af',
  '已投递': '#3b82f6',
  '笔试中': '#f59e0b',
  '面试中': '#8b5cf6',
  '已发offer': '#10b981',
  '已拒': '#ef4444',
  '已过期': '#6b7280',
};

function getStatusColor(status) {
  return STATUS_COLORS[status] || '#9ca3af';
}

function formatCompanySize(size) {
  if (!size) return '-';
  return String(size).replace(/\s*员工数量\s*/g, '').trim() || '-';
}

function formatArrayField(value) {
  if (!value) return '-';
  const arr = Array.isArray(value) ? value : [value];
  if (arr.length <= 2) return arr.join('、');
  return `${arr.slice(0, 2).join('、')} +${arr.length - 2}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '未设置';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '未设置';
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function formatDateTime(dateStr) {
  if (!dateStr) return '未设置';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '未设置';
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function StatusCell({ companyId, originalStatus, localOverrides, setLocalOverrides }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef(null);
  const dropdownRef = useRef(null);
  const currentStatus = localOverrides[companyId] ?? originalStatus;

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target) &&
        btnRef.current && !btnRef.current.contains(e.target)
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

  const handleSelect = (status, e) => {
    e.stopPropagation();
    if (status === originalStatus) {
      setLocalStatus(companyId, null);
      const next = { ...localOverrides };
      delete next[companyId];
      setLocalOverrides(next);
    } else {
      setLocalStatus(companyId, status);
      setLocalOverrides({ ...localOverrides, [companyId]: status });
    }
    close();
  };

  const handleToggle = (e) => {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({
        top: rect.bottom + 4,
        left: rect.left,
      });
    }
    setOpen((v) => !v);
  };

  return (
    <div className="status-cell-wrap" data-label="投递状态">
      <button
        ref={btnRef}
        type="button"
        className="status-badge status-badge--clickable"
        style={{ backgroundColor: getStatusColor(currentStatus || '-') }}
        onClick={handleToggle}
      >
        {currentStatus || '-'}
        <span className="status-arrow" />
      </button>
      {open &&
        createPortal(
          <div className="status-dropdown-overlay" onClick={close}>
            <div
              ref={dropdownRef}
              className="status-dropdown"
              style={{ top: pos.top, left: pos.left }}
              onClick={(e) => e.stopPropagation()}
            >
              {ALL_STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`status-dropdown-item ${s === currentStatus ? 'active' : ''}`}
                  onClick={(e) => handleSelect(s, e)}
                >
                  <span className="status-dot" style={{ backgroundColor: getStatusColor(s) }} />
                  <span className="status-label">{s}</span>
                  {s === currentStatus && <span className="status-check">✓</span>}
                </button>
              ))}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

export default function DataTable({
  data,
  loading,
  pagination,
  onPageChange,
  onRowClick,
}) {
  const [jumpPage, setJumpPage] = useState('');
  const [localOverrides, setLocalOverrides] = useState({});
  const current_page = Math.max(1, Number(pagination?.current_page ?? pagination?.currentPage ?? pagination?.page) || 1);
  const total_pages = Math.max(1, Number(pagination?.total_pages ?? pagination?.totalPages ?? pagination?.pages) || 1);
  const total_items = pagination?.total_items ?? pagination?.totalItems ?? pagination?.total_count ?? pagination?.count ?? pagination?.total ?? data?.length ?? 0;

  useEffect(() => {
    setLocalOverrides(getAllLocalStatuses());
  }, []);

  const getPageNumbers = () => {
    if (!total_pages) return [];
    const pages = [];
    const maxVisible = 7;
    let start = Math.max(1, (current_page || 1) - Math.floor(maxVisible / 2));
    let end = Math.min(total_pages, start + maxVisible - 1);
    if (end - start < maxVisible - 1) {
      start = Math.max(1, end - maxVisible + 1);
    }
    for (let i = start; i <= end; i++) {
      pages.push(i);
    }
    return pages;
  };

  if (loading) {
    return (
      <div className="table-container">
        <div className="loading-state">
          <div className="spinner" />
          <p>正在同步招聘记录...</p>
        </div>
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="table-container">
        <div className="empty-state">
          <div className="empty-illustration" aria-hidden="true">⌁</div>
          <p>没有找到匹配记录</p>
          <span>试试减少筛选条件，或换一个关键词</span>
        </div>
      </div>
    );
  }

  return (
    <div className="table-container">
      <div className="table-scroll">
      <table className="data-table" aria-label="招聘记录列表">
        <caption className="sr-only">招聘记录列表，点击任意行查看详情</caption>
        <thead>
          <tr>
            <th>公司名称</th>
            <th>公司类型</th>
            <th>行业</th>
            <th>规模</th>
            <th>招聘类型</th>
            <th>目标人群</th>
            <th>岗位</th>
            <th>地点</th>
            <th className="col-status">投递状态</th>
            <th className="col-deadline">截止日期</th>
            <th className="col-updated">更新时间</th>
          </tr>
        </thead>
        <tbody>
          {data.map((item) => (
            <tr
              key={item.id}
              className="table-row"
              onClick={() => onRowClick && onRowClick(item.id)}
              onKeyDown={(event) => {
                if ((event.key === 'Enter' || event.key === ' ') && onRowClick) onRowClick(item.id);
              }}
              tabIndex="0"
            >
              <td className="cell-name" data-label="公司名称">{item.name || '未命名公司'}</td>
              <td data-label="公司类型">{item.type || '-'}</td>
              <td data-label="行业">{item.industry || '-'}</td>
              <td data-label="规模">{formatCompanySize(item.company_size)}</td>
              <td data-label="招聘类型">
                {item.recruitment_type ? (
                  <span className="tag tag-recruitment">{item.recruitment_type}</span>
                ) : (
                  '-'
                )}
              </td>
              <td data-label="目标人群">{item.target_candidates || '-'}</td>
              <td className="cell-truncate" data-label="岗位" title={Array.isArray(item.positions) ? item.positions.join('、') : item.positions}>
                {formatArrayField(item.positions)}
              </td>
              <td className="cell-truncate" data-label="地点" title={Array.isArray(item.locations) ? item.locations.join('、') : item.locations}>
                {formatArrayField(item.locations)}
              </td>
              <td className="col-status">
                <StatusCell
                  companyId={item.id}
                  originalStatus={item.progress_status}
                  localOverrides={localOverrides}
                  setLocalOverrides={setLocalOverrides}
                />
              </td>
              <td className={`col-deadline ${item.deadline && !isNaN(new Date(item.deadline).getTime()) && new Date(item.deadline) < new Date() ? 'deadline-expired' : ''}`} data-label="截止日期">
                {formatDate(item.deadline)}
              </td>
              <td className="col-updated" data-label="更新时间">
                {formatDateTime(item.update_time)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      {total_pages > 1 && (
        <div className="pagination">
          <span className="pagination-info">
            共 {total_items} 条，第 {current_page}/{total_pages} 页
          </span>
          <div className="pagination-buttons">
            <button
              className="btn-page"
              disabled={current_page <= 1}
              onClick={() => onPageChange(1)}
            >
              首页
            </button>
            <button
              className="btn-page"
              disabled={current_page <= 1}
              onClick={() => onPageChange(current_page - 1)}
            >
              上一页
            </button>
            {getPageNumbers().map((p) => (
              <button
                key={p}
                className={`btn-page ${p === current_page ? 'active' : ''}`}
                onClick={() => onPageChange(p)}
              >
                {p}
              </button>
            ))}
            <button
              className="btn-page"
              disabled={current_page >= total_pages}
              onClick={() => onPageChange(current_page + 1)}
            >
              下一页
            </button>
            <button
              className="btn-page"
              disabled={current_page >= total_pages}
              onClick={() => onPageChange(total_pages)}
            >
              末页
            </button>
          </div>
          <div className="pagination-jump">
            <span>跳至</span>
            <input
              type="number"
              className="jump-input"
              min="1"
              max={total_pages}
              value={jumpPage}
              onChange={(e) => setJumpPage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const num = parseInt(jumpPage, 10);
                  if (num >= 1 && num <= total_pages) {
                    onPageChange(num);
                    setJumpPage('');
                  }
                }
              }}
              placeholder={`1-${total_pages}`}
            />
            <span>页</span>
            <button
              className="btn-page"
              onClick={() => {
                const num = parseInt(jumpPage, 10);
                if (num >= 1 && num <= total_pages) {
                  onPageChange(num);
                  setJumpPage('');
                }
              }}
              disabled={!jumpPage || parseInt(jumpPage, 10) < 1 || parseInt(jumpPage, 10) > total_pages}
            >
              跳转
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
