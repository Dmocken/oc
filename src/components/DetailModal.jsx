import { useEffect, useState } from 'react';
import './DetailModal.css';

function fmtDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return String(dateStr);
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function fmtDateTime(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return String(dateStr);
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function joinArr(value) {
  if (value === null || value === undefined || value === '') return '';
  return Array.isArray(value) ? value.join('、') : String(value);
}

/**
 * 招聘记录详情弹窗：直接展示列表行携带的 offerbiu 数据，无需额外请求。
 */
export default function DetailModal({ row, onClose }) {
  const [copied, setCopied] = useState(false);
  const r = row || {};
  const item = r.raw || r; // offerbiu 原始条目（若无则退化为归一化行）

  const targetYears = item.targetYears || item.target_candidates;
  const deadline =
    item.deadline_text ||
    (item.deadlineAt ? fmtDate(item.deadlineAt) : item.deadline ? fmtDate(item.deadline) : '-');
  const updatedAt = item.sourceUpdatedAt || item.updatedAt || item.update_time || null;
  const applyUrl = r.apply_url || item.applyUrl || '';
  const announcementUrl = item.announcementUrl || '';

  useEffect(() => {
    const handleKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handleKeyDown); document.body.style.overflow = previousOverflow; };
  }, [onClose]);

  const copyText = async (text) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  const renderLinks = () => {
    const links = [];
    if (applyUrl) {
      links.push({ label: '投递申请', url: applyUrl, text: item.applyText || '' });
    }
    if (announcementUrl) {
      links.push({ label: '招聘公告', url: announcementUrl });
    }
    return links;
  };

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal-content" role="dialog" aria-modal="true" aria-labelledby="detail-title">
        <button className="modal-close" onClick={onClose} aria-label="关闭详情">
          &times;
        </button>

        <div className="modal-header">
          <div>
            <span className="modal-kicker">
              {item.seasonYear ? `${item.seasonYear}届招聘` : 'RECRUITMENT'}
              {item.visibilityTier === 'VIP' && <span className="vip-pill">VIP</span>}
            </span>
            <h2 id="detail-title">{r.name || item.companyName || '未命名公司'}</h2>
          </div>
          <span className="detail-id">ID: {item.id || r.id}</span>
        </div>

        <div className="modal-body">
          <section className="detail-section">
            <h3>基本信息</h3>
            <div className="detail-grid">
              <div className="detail-item">
                <span className="detail-label">公司类型</span>
                <span className="detail-value">{item.companyNature || r.type || '-'}</span>
              </div>
              <div className="detail-item">
                <span className="detail-label">行业</span>
                <span className="detail-value">{item.industry || r.industry || '-'}</span>
              </div>
              <div className="detail-item">
                <span className="detail-label">招聘类型</span>
                <span className="detail-value">{item.recruitType || r.recruitment_type || '-'}</span>
              </div>
              <div className="detail-item">
                <span className="detail-label">目标届别</span>
                <span className="detail-value">
                  {Array.isArray(targetYears)
                    ? targetYears.map((y) => `${y}届`).join('、')
                    : targetYears || '-'}
                </span>
              </div>
              <div className="detail-item">
                <span className="detail-label">笔试政策</span>
                <span className="detail-value">{item.examPolicy || '-'}</span>
              </div>
              <div className="detail-item">
                <span className="detail-label">截止时间</span>
                <span className="detail-value">{deadline}</span>
              </div>
              <div className="detail-item">
                <span className="detail-label">更新时间</span>
                <span className="detail-value">{updatedAt ? fmtDateTime(updatedAt) : '-'}</span>
              </div>
            </div>
          </section>

          <section className="detail-section">
            <h3>岗位信息</h3>
            <div className="detail-grid">
              <div className="detail-item full-width">
                <span className="detail-label">岗位</span>
                <span className="detail-value">{joinArr(item.positionsText || r.positions) || '-'}</span>
              </div>
              <div className="detail-item full-width">
                <span className="detail-label">工作地点</span>
                <span className="detail-value">{joinArr(item.locations) || '-'}</span>
              </div>
            </div>
          </section>

          {renderLinks().length > 0 && (
            <section className="detail-section">
              <h3>相关链接</h3>
              <div className="detail-grid">
                {renderLinks().map((link) => (
                  <div key={link.label} className="detail-item">
                    <span className="detail-label">{link.label}</span>
                    <div className="detail-value link-value">
                      <a href={link.url} target="_blank" rel="noopener noreferrer" className="detail-link">
                        {link.text || link.url}
                      </a>
                      <button type="button" className="copy-button" onClick={() => copyText(link.url)}>
                        {copied ? '已复制' : '复制链接'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {(item.noteText || item.note_text) && (
            <section className="detail-section">
              <h3>备注</h3>
              <p className="detail-notes">{item.noteText || item.note_text}</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
