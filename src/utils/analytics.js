import { auth } from '../firebase';

export const EDGE_API_URL = String(import.meta.env.VITE_EDGE_API_URL || '').replace(/\/$/, '');
const API_BASE = EDGE_API_URL || '';
const VISITOR_STORAGE_KEY = 'weflix_analytics_visitor_id';
let analyticsQueue = Promise.resolve();

const visitorId = (() => {
  if (typeof window === 'undefined') return 'server-render';
  try {
    const existing = window.localStorage.getItem(VISITOR_STORAGE_KEY);
    if (existing) return existing;
    const created = globalThis.crypto?.randomUUID?.() || `visitor-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(VISITOR_STORAGE_KEY, created);
    return created;
  } catch {
    return `visitor-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
})();

const analyticsRequest = async (path, options = {}) => {
  await auth.authStateReady();
  const user = auth.currentUser;
  const token = user ? await user.getIdToken() : '';
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
    keepalive: options.keepalive ?? true,
  });
  if (!response.ok) throw new Error(`Analytique indisponible (${response.status})`);
  return response.json().catch(() => null);
};

export const sendAnalyticsEvent = (type, payload = {}) => {
  const request = () => analyticsRequest('/api/analytics/event', {
    method: 'POST',
    body: JSON.stringify({ type, visitorId, ...payload }),
  }).catch(() => null);

  // A page view and its first presence heartbeat are emitted together. Keeping
  // them ordered prevents two R2 read/modify/write operations from erasing a
  // freshly incremented playback or page-view counter.
  const result = analyticsQueue.then(request, request);
  analyticsQueue = result.then(() => undefined, () => undefined);
  return result;
};

export const createAdminSession = async (username, password) => {
  const response = await fetch(`${API_BASE}/api/admin/session`, {
    method: 'POST',
    headers: { 'X-Admin-Username': username, 'X-Admin-Password': password },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Connexion administrateur impossible');
  return result;
};

export const loadAdminAnalytics = async (sessionToken) => {
  const response = await fetch(`${API_BASE}/api/admin/analytics`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
    cache: 'no-store',
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Statistiques indisponibles');
  return result;
};
