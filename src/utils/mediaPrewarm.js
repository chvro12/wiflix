import { auth } from '../firebase';

const EDGE_API_URL = String(import.meta.env.VITE_EDGE_API_URL || '').replace(/\/$/, '');

export const scheduleMediaPrewarm = ({ mediaType, mediaId, season, episode, delay = 1_500 }) => {
  if (!mediaId || !['movie', 'tv'].includes(mediaType)) return () => {};

  const controller = new AbortController();
  const timer = window.setTimeout(async () => {
    try {
      await auth.authStateReady();
      const user = auth.currentUser;
      if (!user) return;
      const token = await user.getIdToken();
      const payload = { mediaType, mediaId: Number(mediaId) };
      if (mediaType === 'tv') {
        payload.season = Number(season) || 1;
        payload.episode = Number(episode) || 1;
      }
      await fetch(`${EDGE_API_URL}/api/media/request`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      if (error.name !== 'AbortError') console.debug('Préparation anticipée ignorée.');
    }
  }, delay);

  return () => {
    window.clearTimeout(timer);
    controller.abort();
  };
};
