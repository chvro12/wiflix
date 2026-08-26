import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { sendAnalyticsEvent } from '../utils/analytics';

export default function SiteAnalytics() {
  const location = useLocation();
  const lastPath = useRef('');

  useEffect(() => {
    const path = `${location.pathname}${location.search}`;
    if (path === lastPath.current || path.startsWith('/admin')) return;
    lastPath.current = path;
    sendAnalyticsEvent('page_view', { path, title: document.title });
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (location.pathname.startsWith('/admin')) return undefined;
    const heartbeat = () => sendAnalyticsEvent('presence', {
      path: `${window.location.pathname}${window.location.search}`,
      title: document.title,
    });
    heartbeat();
    const timer = window.setInterval(heartbeat, 30_000);
    const onVisibility = () => { if (!document.hidden) heartbeat(); };
    const onPageHide = () => sendAnalyticsEvent('presence_leave', {
      path: `${window.location.pathname}${window.location.search}`,
      title: document.title,
    });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [location.pathname]);

  return null;
}
