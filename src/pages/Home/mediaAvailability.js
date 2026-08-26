export const movieReleaseCutoff = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

export const isMovieReleased = (item, now = Date.now()) => {
  const releaseDate = item?.release_date || item?.primary_release_date || '';
  return Boolean(releaseDate) && releaseDate <= movieReleaseCutoff(now);
};

export const isMovieUpcoming = (item, now = Date.now()) => {
  const releaseDate = item?.release_date || item?.primary_release_date || '';
  return Boolean(releaseDate) && releaseDate > movieReleaseCutoff(now);
};

export const isDisplayableMedia = (item, fallbackType) => {
  const mediaType = item?.media_type || fallbackType;
  return mediaType === 'tv' || isMovieReleased(item);
};

export const isCatalogueVisible = (item, fallbackType, catalogue) => {
  if (!isDisplayableMedia(item, fallbackType)) return false;
  if (!catalogue?.movies || !catalogue?.series) return false;
  const mediaType = item?.media_type || fallbackType;
  const mediaId = Number(item?.id);
  if (!Number.isInteger(mediaId) || mediaId <= 0) return false;
  if (mediaType === 'movie') return catalogue.movies.has(mediaId);
  if (mediaType === 'tv') return catalogue.series.has(mediaId);
  return false;
};

export const addMovieAvailabilityParams = (url) => {
  url.searchParams.set('region', 'FR');
  url.searchParams.set('primary_release_date.lte', movieReleaseCutoff());
  return url;
};
