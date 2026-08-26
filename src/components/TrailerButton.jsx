import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import PropTypes from 'prop-types';
import { FaFilm, FaSpinner, FaTimes } from 'react-icons/fa';
import { selectPreferredTrailer } from '../pages/Home/trailerSelection';

const trailerCache = new Map();

const loadTrailer = async (mediaType, mediaId, signal) => {
  const cacheKey = `${mediaType}/${mediaId}`;
  if (trailerCache.has(cacheKey)) return trailerCache.get(cacheKey);
  const apiKey = import.meta.env.VITE_TMDB_API;
  const baseUrl = `${import.meta.env.VITE_BASE_URL}/${mediaType}/${mediaId}/videos?api_key=${encodeURIComponent(apiKey)}`;
  const request = async (url) => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`TMDB a répondu ${response.status}`);
    return (await response.json()).results || [];
  };
  const responses = await Promise.allSettled([
    request(`${baseUrl}&language=fr-FR`),
    request(baseUrl),
  ]);
  const videos = responses.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  const selected = selectPreferredTrailer(videos);
  if (selected) trailerCache.set(cacheKey, selected);
  return selected;
};

const TrailerButton = ({ mediaType, mediaId, title }) => {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [trailer, setTrailer] = useState(null);
  const [error, setError] = useState('');
  const requestRef = useRef(null);

  useEffect(() => {
    requestRef.current?.abort();
    setOpen(false);
    setLoading(false);
    setTrailer(null);
    setError('');
  }, [mediaType, mediaId]);

  useEffect(() => () => requestRef.current?.abort(), []);

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') {
        requestRef.current?.abort();
        setLoading(false);
        setOpen(false);
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const showTrailer = async () => {
    setOpen(true);
    if (trailer || loading) return;
    setLoading(true);
    setError('');
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const selected = await loadTrailer(mediaType, mediaId, controller.signal);
      if (!selected) throw new Error('Aucune bande-annonce disponible pour le moment.');
      setTrailer(selected);
    } catch (loadError) {
      if (loadError.name === 'AbortError') return;
      setError(loadError.message || 'Impossible de charger la bande-annonce.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  const closeTrailer = () => {
    requestRef.current?.abort();
    setLoading(false);
    setOpen(false);
  };

  const modal = open ? createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/90 p-3 backdrop-blur-md sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={`Bande-annonce de ${title}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeTrailer();
      }}
    >
      <div className="relative flex max-h-[calc(100dvh-1.5rem)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl sm:max-h-[calc(100dvh-4rem)]">
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-white/10 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wider text-red-400">Bande-annonce</p>
            <h2 className="truncate text-base font-bold text-white sm:text-lg">{title}</h2>
          </div>
          <button
            type="button"
            onClick={closeTrailer}
            className="shrink-0 rounded-full bg-white/10 p-2.5 text-white transition-colors hover:bg-white/20"
            aria-label="Fermer la bande-annonce"
          >
            <FaTimes />
          </button>
        </div>

        <div className="aspect-video min-h-0 w-full bg-black">
          {loading && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-gray-300">
              <FaSpinner className="animate-spin text-3xl text-red-500" />
              <span>Recherche de la bande-annonce française…</span>
            </div>
          )}
          {!loading && error && (
            <div className="flex h-full items-center justify-center px-6 text-center text-gray-300">{error}</div>
          )}
          {!loading && trailer && (
            <iframe
              className="h-full w-full"
              src={`https://www.youtube-nocookie.com/embed/${trailer.key}?autoplay=1&controls=1&rel=0&modestbranding=1&playsinline=1&hl=fr&cc_lang_pref=fr`}
              title={`Bande-annonce de ${title}`}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              referrerPolicy="strict-origin-when-cross-origin"
              allowFullScreen
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        type="button"
        onClick={showTrailer}
        className="flex items-center gap-2 rounded-xl border border-white/15 bg-black/35 px-6 py-3 font-bold text-white backdrop-blur-md transition-all hover:bg-white/15 active:scale-[0.98]"
      >
        <FaFilm className="text-sm" />
        Bande-annonce
      </button>

      {modal}
    </>
  );
};

TrailerButton.propTypes = {
  mediaType: PropTypes.oneOf(['movie', 'tv']).isRequired,
  mediaId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
  title: PropTypes.string.isRequired,
};

export default TrailerButton;
