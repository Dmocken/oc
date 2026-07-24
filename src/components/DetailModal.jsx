import { useState, useEffect } from 'react';
import { fetchCompanyDetail } from '../api';
import './DetailModal.css';

export default function DetailModal({ companyId, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchCompanyDetail(companyId);
        if (!cancelled) setDetail(data);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [companyId]);

  useEffect(() => {
    const handleKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handleKeyDown); document.body.style.overflow = previousOverflow; };
  }, [onClose]);

  const copyReferral = async () => {
    if (!detail?.referral_code) return;
    try {
      await navigator.clipboard.writeText(detail.referral_code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  const renderLinks = (links) => {
    if (!links) return null;
    let parsed = links;
    if (typeof links === 'string') {
      try { parsed = JSON.parse(links); } catch { parsed = links; }
    }
    if (typeof parsed === 'string') {
      // 尝试从文本中提取 URL
      const urlRegex = /https?:\/\/[^\s,，]+/g;
      const urls = parsed.match(urlRegex);
      if (urls) {
        return urls.map((url, i) => (
          <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="detail-link">
            {url}
          </a>
        ));
      }
      return <span>{parsed}</span>;
    }
    if (Array.isArray(parsed)) {
      return parsed.map((item, i) => (
        <div key={i}>
          {typeof item === 'string' ? (
            <a href={item} target="_blank" rel="noopener noreferrer" className="detail-link">
              {item}
            </a>
          ) : (
            <pre className="detail-json">{JSON.stringify(item, null, 2)}</pre>
          )}
        </div>
      ));
    }
    if (typeof parsed === 'object') {
      return <pre className="detail-json">{JSON.stringify(parsed, null, 2)}</pre>;
    }
    return <span>{String(links)}</span>;
  };

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal-content" role="dialog" aria-modal="true" aria-labelledby="detail-title">
        <button className="modal-close" onClick={onClose} aria-label="关闭详情">
          &times;
        </button>

        {loading && (
          <div className="modal-loading">
            <div className="spinner" />
            <p>加载详情中...</p>
          </div>
        )}

        {error && (
          <div className="modal-error">
            <p>加载失败: {error}</p>
            <button className="btn btn-primary" onClick={onClose}>关闭</button>
          </div>
        )}

        {detail && !loading && !error && (
          <>
            <div className="modal-header">
              <div><span className="modal-kicker">COMPANY DETAIL</span><h2 id="detail-title">{detail.name}</h2></div>
              <span className="detail-id">ID: {detail.id}</span>
            </div>

            <div className="modal-body">
              <section className="detail-section">
                <h3>基本信息</h3>
                <div className="detail-grid">
                  <div className="detail-item">
                    <span className="detail-label">公司类型</span>
                    <span className="detail-value">{detail.type || '-'}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">行业</span>
                    <span className="detail-value">{detail.industry || '-'}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">公司规模</span>
                    <span className="detail-value">{detail.company_size || '-'}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">招聘类型</span>
                    <span className="detail-value">{detail.recruitment_type || '-'}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">目标人群</span>
                    <span className="detail-value">{detail.target_candidates || '-'}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">投递状态</span>
                    <span className="detail-value">{detail.progress_status || '-'}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">截止日期</span>
                    <span className="detail-value">
                      {detail.deadline ? new Date(detail.deadline).toLocaleDateString('zh-CN') : '-'}
                    </span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">更新时间</span>
                    <span className="detail-value">
                      {detail.update_time ? new Date(detail.update_time).toLocaleString('zh-CN') : '-'}
                    </span>
                  </div>
                </div>
              </section>

              <section className="detail-section">
                <h3>岗位信息</h3>
                <div className="detail-grid">
                  <div className="detail-item full-width">
                    <span className="detail-label">岗位</span>
                    <span className="detail-value">
                      {Array.isArray(detail.positions)
                        ? detail.positions.join('、')
                        : (detail.positions || '-')}
                    </span>
                  </div>
                  <div className="detail-item full-width">
                    <span className="detail-label">地点</span>
                    <span className="detail-value">
                      {Array.isArray(detail.locations)
                        ? detail.locations.join('、')
                        : (detail.locations || '-')}
                    </span>
                  </div>
                </div>
              </section>

              {(detail.related_links || detail.recruitment_notice) && (
                <section className="detail-section">
                  <h3>相关链接</h3>
                  {detail.related_links && (
                    <div className="detail-item">
                      <span className="detail-label">投递链接</span>
                      <div className="detail-value">{renderLinks(detail.related_links)}</div>
                    </div>
                  )}
                  {detail.recruitment_notice && (
                    <div className="detail-item">
                      <span className="detail-label">招聘公告</span>
                      <div className="detail-value">{renderLinks(detail.recruitment_notice)}</div>
                    </div>
                  )}
                </section>
              )}

              {detail.referral_code && (
                <section className="detail-section">
                  <h3>推荐码</h3>
                  <div className="referral-row"><code className="referral-code">{detail.referral_code}</code><button type="button" className="copy-button" onClick={copyReferral}>{copied ? '已复制' : '复制'}</button></div>
                </section>
              )}

              {detail.exam_info && (
                <section className="detail-section">
                  <h3>笔试信息</h3>
                  <div className="detail-value">
                    {typeof detail.exam_info === 'string'
                      ? detail.exam_info
                      : renderLinks(detail.exam_info)}
                  </div>
                </section>
              )}

              {detail.notes && (
                <section className="detail-section">
                  <h3>备注</h3>
                  <p className="detail-notes">{detail.notes}</p>
                </section>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
