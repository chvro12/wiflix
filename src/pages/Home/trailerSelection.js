const isFrench = (video) => {
  const language = String(video?.iso_639_1 || '').toLowerCase();
  const name = String(video?.name || '').toLowerCase();
  return language === 'fr' || /\b(vf|vostfr|fran[cç]ais)\b/.test(name);
};

const trailerScore = (video) => {
  if (video?.site !== 'YouTube' || !['Trailer', 'Teaser'].includes(video?.type) || !video?.key) return -1;
  const typeScore = video.type === 'Trailer' ? 200 : 100;
  const languageScore = isFrench(video) ? 1000 : 0;
  const officialScore = video.official ? 50 : 0;
  return languageScore + typeScore + officialScore;
};

export const selectPreferredTrailer = (videos = []) => [...new Map(
  videos.filter(Boolean).map((video) => [video.key, video]),
).values()]
  .filter((video) => trailerScore(video) >= 0)
  .sort((left, right) => {
    const scoreDifference = trailerScore(right) - trailerScore(left);
    if (scoreDifference) return scoreDifference;
    return Date.parse(right.published_at || 0) - Date.parse(left.published_at || 0);
  })[0] || null;
