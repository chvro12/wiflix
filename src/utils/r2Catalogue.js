import { useQuery } from '@tanstack/react-query';

export const EDGE_API_URL = String(import.meta.env.VITE_EDGE_API_URL || 'https://weflix-edge.weflix-tsamba.workers.dev').replace(/\/$/, '');

const CACHE_MS = 5 * 60 * 1000;
let cachedCatalogue = null;
let cachedAt = 0;

export const fetchR2Catalogue = async () => {
  if (cachedCatalogue && Date.now() - cachedAt < CACHE_MS) return cachedCatalogue;
  const response = await fetch(`${EDGE_API_URL}/api/catalogue/available`);
  if (!response.ok) throw new Error('Catalogue R2 indisponible');
  const payload = await response.json();
  cachedCatalogue = {
    movies: new Set((payload.movies || []).map(Number)),
    series: new Set((payload.series || []).map(Number)),
    generatedAt: payload.generatedAt || null,
  };
  cachedAt = Date.now();
  return cachedCatalogue;
};

export const isR2Streamable = (item, fallbackType, catalogue) => {
  if (!catalogue?.movies || !catalogue?.series) return false;
  const mediaType = item?.media_type || fallbackType;
  const mediaId = Number(item?.id);
  if (!Number.isInteger(mediaId) || mediaId <= 0) return false;
  if (mediaType === 'movie') return catalogue.movies.has(mediaId);
  if (mediaType === 'tv') return catalogue.series.has(mediaId);
  return false;
};

export const useR2Catalogue = () => useQuery({
  queryKey: ['r2-catalogue'],
  queryFn: fetchR2Catalogue,
  staleTime: CACHE_MS,
  gcTime: 15 * 60 * 1000,
  retry: 2,
});
