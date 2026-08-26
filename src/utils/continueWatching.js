import { doc, setDoc, deleteDoc, getDocs, collection, query, orderBy } from 'firebase/firestore';
import { db } from '../firebase';

// Helper to save current movie/show to user's continue_watching list in Firestore
export const saveToContinueWatching = async (userUid, item) => {
  if (!userUid || !item || !item.id) return;

  try {
    try {
      const cached = JSON.parse(localStorage.getItem('wf_cw_cache_items') || '[]');
      if (Array.isArray(cached)) {
        const index = cached.findIndex((entry) => String(entry?.id) === String(item.id));
        if (index >= 0) cached[index] = { ...cached[index], ...item, updatedAt: Date.now() };
        else cached.unshift({ ...item, updatedAt: Date.now() });
        localStorage.setItem('wf_cw_cache_items', JSON.stringify(cached.slice(0, 20)));
      }
    } catch { /* Firestore remains available if local storage is full. */ }
    const ref = doc(db, 'users', userUid, 'continue_watching', String(item.id));
    await setDoc(ref, {
      ...item,
      updatedAt: Date.now(),
    }, { merge: true });

    // Enforce max logic per-user on write inside Cloud Functions or securely in frontend:
    // Here we clean up old items if > 20
    const q = query(collection(db, 'users', userUid, 'continue_watching'), orderBy('updatedAt', 'desc'));
    const snaps = await getDocs(q);
    if (snaps.docs.length > 20) {
      // Delete anything beyond top 20
      const toDelete = snaps.docs.slice(20);
      for (const d of toDelete) {
        await deleteDoc(d.ref);
      }
    }
  } catch (err) {
    console.error('Failed to save to continue watching in Firestore', err);
  }
};

const matchesLookupPath = (item, lookupPath) => {
  const [kind, id, season, episode] = String(lookupPath || '').split('/');
  if (String(item?.id) !== String(id)) return false;
  if (kind === 'movie') return item?.mediaType === 'movie';
  return item?.mediaType === 'tv'
    && Number(item?.season) === Number(season)
    && Number(item?.episode) === Number(episode);
};

export const getSavedPlaybackPosition = (lookupPath) => {
  try {
    const items = JSON.parse(localStorage.getItem('wf_cw_cache_items') || '[]');
    const item = Array.isArray(items) ? items.find((entry) => matchesLookupPath(entry, lookupPath)) : null;
    const position = Math.max(0, Number(item?.position) || 0);
    const duration = Math.max(0, Number(item?.duration) || 0);
    return duration > 0 && position >= duration - 30 ? 0 : position;
  } catch {
    return 0;
  }
};

export const savePlaybackPosition = async (userUid, lookupPath, position, duration) => {
  if (!userUid || !lookupPath) return;
  const [kind, id, season, episode] = String(lookupPath).split('/');
  if (!id || !['movie', 'episode'].includes(kind)) return;
  const safeDuration = Math.max(0, Math.round(Number(duration) || 0));
  const safePosition = safeDuration > 0 && Number(position) >= safeDuration - 30
    ? 0
    : Math.max(0, Math.round(Number(position) || 0));
  const patch = {
    id: Number(id),
    mediaType: kind === 'movie' ? 'movie' : 'tv',
    position: safePosition,
    duration: safeDuration,
    updatedAt: Date.now(),
    ...(kind === 'episode' ? { season: Number(season), episode: Number(episode) } : {}),
  };

  // Update the local cache synchronously so reopening the page on this device
  // resumes correctly even before Firestore's snapshot arrives.
  try {
    const items = JSON.parse(localStorage.getItem('wf_cw_cache_items') || '[]');
    if (Array.isArray(items)) {
      const index = items.findIndex((entry) => String(entry?.id) === String(id));
      if (index >= 0) items[index] = { ...items[index], ...patch };
      localStorage.setItem('wf_cw_cache_items', JSON.stringify(items));
    }
  } catch { /* Firestore remains the source of truth. */ }

  try {
    await setDoc(doc(db, 'users', userUid, 'continue_watching', String(id)), patch, { merge: true });
  } catch (err) {
    console.error('Failed to save playback position in Firestore', err);
  }
};

export const removeFromContinueWatching = async (userUid, id) => {
  if (!userUid || !id) return;
  try {
    const ref = doc(db, 'users', userUid, 'continue_watching', String(id));
    await deleteDoc(ref);
  } catch (err) {
    console.error('Failed to remove from continue watching', err);
  }
};
