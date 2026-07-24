const STORAGE_KEY = 'recruitment_status_overrides';

/**
 * 获取所有本地保存的状态覆盖
 */
export function getAllLocalStatuses() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * 获取单条记录的状态（优先本地覆盖）
 */
export function getLocalStatus(id, fallback) {
  const all = getAllLocalStatuses();
  return all[id] !== undefined ? all[id] : fallback;
}

/**
 * 保存单条记录的状态到本地
 */
export function setLocalStatus(id, status) {
  const all = getAllLocalStatuses();
  all[id] = status;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

/**
 * 删除单条记录的状态覆盖
 */
export function removeLocalStatus(id) {
  const all = getAllLocalStatuses();
  delete all[id];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}
