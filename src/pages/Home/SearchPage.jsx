import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import PropTypes from 'prop-types';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { toDetailPath } from './urlUtils';
import { FaSearch, FaTimes, FaChevronDown } from 'react-icons/fa';
import { BiMoviePlay, BiTv, BiSliderAlt } from 'react-icons/bi';
import ContentCard from './ContentCard';
import { GENRES, SPECIAL_CATEGORIES, SPECIAL_PARAMS } from './tmdb';
import { buildBrowsePath } from './urlFilters';
import SEO from './SEO';
import { addMovieAvailabilityParams, isCatalogueVisible } from './mediaAvailability';
import { useR2Catalogue } from '../../utils/r2Catalogue';

const CONFIG = {
  BASE_URL: `${String(import.meta.env.VITE_EDGE_API_URL || 'https://weflix-edge.weflix-tsamba.workers.dev').replace(/\/$/, '')}/api/tmdb`,
  IMAGE_BASE_URL: 'https://image.tmdb.org/t/p/w500',
  DEBOUNCE_DELAY: 350,
};

const GRID_CLASSES = 'grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-3 sm:gap-4 mt-4';

const ALL_CATEGORIES = [
  ...GENRES.movie.map(g => ({ ...g, mediaType: 'movie', path: buildBrowsePath('movie', g.id, 'popularity.desc') })),
  ...GENRES.tv.map(g => ({ ...g, mediaType: 'tv', path: buildBrowsePath('tv', g.id, 'popularity.desc') })),
  ...SPECIAL_CATEGORIES.movie.map(g => ({ ...g, mediaType: 'movie', path: buildBrowsePath('movie', g.id, 'popularity.desc') })),
  ...SPECIAL_CATEGORIES.tv.map(g => ({ ...g, mediaType: 'tv', path: buildBrowsePath('tv', g.id, 'popularity.desc') })),
];

const UNIQUE_CATEGORIES = ALL_CATEGORIES.filter(
  (cat, idx, arr) => arr.findIndex(c => c.name === cat.name && c.mediaType === cat.mediaType) === idx
);

// ── Sort options ──────────────────────────────────────────────────────────────
const SORT_OPTIONS = [
  { label: 'Les plus populaires', value: 'popularity.desc' },
  { label: 'Les mieux notés', value: 'vote_average.desc' },
  { label: 'Les plus récents', value: 'release_date.desc' },
  { label: 'Les plus anciens', value: 'release_date.asc' },
];

// ── Rating presets ────────────────────────────────────────────────────────────
const RATING_OPTIONS = [
  { label: 'Toutes les notes', value: 0 },
  { label: '6+ Bon', value: 6 },
  { label: '7+ Très bon', value: 7 },
  { label: '8+ Excellent', value: 8 },
  { label: '9+ Chef-d’œuvre', value: 9 },
];

// ── Default filters ───────────────────────────────────────────────────────────
const DEFAULT_FILTERS = {
  mediaType: 'all',  // 'all' | 'movie' | 'tv'
  genreId: null,
  yearFrom: '',
  yearTo: '',
  minRating: 0,
  sortBy: 'popularity.desc',
};
const CATALOGUE_DEFAULT_FILTERS = { ...DEFAULT_FILTERS, mediaType: 'movie' };
const filtersFromParams = (params) => {
  const mediaType = params.get('type') === 'tv' ? 'tv' : 'movie';
  const genreId = Number(params.get('theme'));
  const minRating = Number(params.get('note'));
  const sortBy = SORT_OPTIONS.some((option) => option.value === params.get('tri')) ? params.get('tri') : 'popularity.desc';
  return {
    mediaType,
    genreId: Number.isInteger(genreId) && genreId !== 0 ? genreId : null,
    yearFrom: /^\d{4}$/.test(params.get('depuis') || '') ? params.get('depuis') : '',
    yearTo: /^\d{4}$/.test(params.get('jusqua') || '') ? params.get('jusqua') : '',
    minRating: RATING_OPTIONS.some((option) => option.value === minRating) ? minRating : 0,
    sortBy,
  };
};

const SkeletonGrid = ({ count = 14 }) => (
  <div className={GRID_CLASSES}>
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="aspect-[2/3] rounded-xl bg-white/5 animate-pulse" />
    ))}
  </div>
);

const normalizeItems = (pages, catalogue) => {
  const seen = new Set();
  const merged = [];
  for (const page of pages) {
    for (const item of page.results ?? []) {
      if (!item.poster_path) continue;
      const mediaType = item.media_type === 'tv' ? 'tv' : 'movie';
      if (!isCatalogueVisible(item, mediaType, catalogue)) continue;
      const key = `${mediaType}_${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
};

const matchesSpecialTheme = (item, mediaType, themeId) => {
  const language = String(item.original_language || '').toLowerCase();
  const genres = item.genre_ids || [];
  if (themeId === -1) return language === 'ja' && genres.includes(16);
  if (mediaType === 'movie') {
    return (themeId === -2 && language === 'th')
      || (themeId === -3 && language === 'ko')
      || (themeId === -4 && language === 'zh');
  }
  return (themeId === -2 && language === 'ko')
    || (themeId === -3 && language === 'zh' && !genres.includes(16))
    || (themeId === -4 && language === 'zh' && genres.includes(16))
    || (themeId === -5 && language === 'th');
};

const getNextPageParam = (lastPage, allPages) => {
  const maxPages = Math.min(lastPage.totalPages ?? 1, 500);
  const nextPage = allPages.length + 1;
  return nextPage <= maxPages ? nextPage : undefined;
};

SkeletonGrid.propTypes = { count: PropTypes.number };

function SearchPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: catalogue } = useR2Catalogue();
  const isCatalogue = location.pathname.startsWith('/catalogue');
  const [searchParams, setSearchParams] = useSearchParams();
  const inputRef = useRef(null);
  const sentinelRef = useRef(null);

  const initialQuery = searchParams.get('q') || '';
  const [query, setQuery] = useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery);

  // Filter panel state
  const [filters, setFilters] = useState(() => isCatalogue ? filtersFromParams(searchParams) : DEFAULT_FILTERS);

  // Genres list based on selected mediaType
  const genreList = useMemo(() => {
    if (filters.mediaType === 'movie') return [...GENRES.movie, ...SPECIAL_CATEGORIES.movie];
    if (filters.mediaType === 'tv') return [...GENRES.tv, ...SPECIAL_CATEGORIES.tv];
    // 'all' → merge deduplicated
    const seen = new Set();
    return [...GENRES.movie, ...SPECIAL_CATEGORIES.movie, ...GENRES.tv, ...SPECIAL_CATEGORIES.tv]
      .filter(g => { if (seen.has(g.name)) return false; seen.add(g.name); return true; });
  }, [filters.mediaType]);

  const activeTheme = genreList.find((theme) => theme.id === filters.genreId) || null;
  const isSearching = debouncedQuery.trim().length > 0;
  const hasBrowseFilters = filters.mediaType !== 'all' || filters.genreId !== null || filters.yearFrom || filters.yearTo || filters.minRating > 0 || filters.sortBy !== 'popularity.desc';
  const isBrowsing = !isSearching && (isCatalogue || hasBrowseFilters);

  useEffect(() => {
    if (window.matchMedia('(min-width: 768px)').matches) {
      inputRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), CONFIG.DEBOUNCE_DELAY);
    return () => clearTimeout(id);
  }, [query]);

  useEffect(() => {
    const next = debouncedQuery.trim();
    const current = searchParams.get('q') || '';
    if (next === current) return;
    const params = new URLSearchParams(searchParams);
    if (next) params.set('q', next);
    else params.delete('q');
    setSearchParams(params, { replace: true });
  }, [debouncedQuery, searchParams, setSearchParams]);

  useEffect(() => {
    if (!isCatalogue) return;
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.set('type', filters.mediaType);
      if (filters.genreId !== null) params.set('theme', String(filters.genreId)); else params.delete('theme');
      if (filters.yearFrom) params.set('depuis', filters.yearFrom); else params.delete('depuis');
      if (filters.yearTo) params.set('jusqua', filters.yearTo); else params.delete('jusqua');
      if (filters.minRating > 0) params.set('note', String(filters.minRating)); else params.delete('note');
      if (filters.sortBy !== 'popularity.desc') params.set('tri', filters.sortBy); else params.delete('tri');
      return params;
    }, { replace: true });
  }, [filters, isCatalogue, setSearchParams]);

  // Reset genre when media type changes
  const setFilter = useCallback((key, value) => {
    setFilters(prev => {
      const next = { ...prev, [key]: value };
      if (key === 'mediaType') next.genreId = null;
      return next;
    });
  }, []);

  const resetFilters = useCallback(() => setFilters(isCatalogue ? CATALOGUE_DEFAULT_FILTERS : DEFAULT_FILTERS), [isCatalogue]);

  // ── Build TMDB discover URL for browse mode ────────────────────────────────
  const buildBrowseUrl = useCallback((pageParam) => {
    const type = filters.mediaType === 'tv' ? 'tv' : 'movie';
    const url = new URL(`${CONFIG.BASE_URL}/discover/${type}`);
    url.searchParams.append('page', pageParam);
    url.searchParams.append('include_adult', 'false');
    url.searchParams.append('language', 'fr-FR');
    if (type === 'movie') addMovieAvailabilityParams(url);

    // Sort
    const sortBy = filters.sortBy === 'release_date.desc' || filters.sortBy === 'release_date.asc'
      ? (type === 'tv'
          ? filters.sortBy.replace('release_date', 'first_air_date')
          : filters.sortBy.replace('release_date', 'primary_release_date'))
      : filters.sortBy;
    url.searchParams.append('sort_by', sortBy);

    // Min rating
    if (filters.minRating > 0) {
      url.searchParams.append('vote_average.gte', filters.minRating);
    }

    // Require a minimum vote count if sorting by rating or filtering by rating
    if (filters.minRating > 0 || filters.sortBy === 'vote_average.desc') {
      url.searchParams.append('vote_count.gte', '300'); // Filter out obscure 10/10 outliers
    } else if (filters.sortBy !== 'popularity.desc') {
      // For Newest/Oldest First, require at least some votes to weed out fake/obscure junk
      url.searchParams.append('vote_count.gte', '50');
    }

    // Year range
    const dateGteKey = type === 'tv' ? 'first_air_date.gte' : 'primary_release_date.gte';
    const dateLteKey = type === 'tv' ? 'first_air_date.lte' : 'primary_release_date.lte';
    
    if (filters.yearFrom) {
      url.searchParams.append(dateGteKey, `${filters.yearFrom}-01-01`);
    }

    if (filters.yearTo) {
      url.searchParams.append(dateLteKey, `${filters.yearTo}-12-31`);
    } else if (filters.sortBy === 'release_date.desc') {
      // If 'Newest First' is selected with no max year, cap it to today
      // This prevents seeing unreleased vaporware movies from the year 2031
      const today = new Date().toISOString().split('T')[0];
      url.searchParams.append(dateLteKey, today);
    }

    // Thème ou sélection internationale
    if (filters.genreId !== null && filters.genreId > 0) {
      url.searchParams.append('with_genres', filters.genreId);
    } else if (filters.genreId !== null && filters.genreId < 0) {
      const special = SPECIAL_PARAMS[`${filters.genreId}_${type}`] || {};
      Object.entries(special).forEach(([key, value]) => url.searchParams.append(key, value));
    }

    return url.toString();
  }, [filters]);

  // ── Combined query key ─────────────────────────────────────────────────────
  const browseQueryKey = useMemo(() => [
    'browse',
    filters.mediaType,
    filters.genreId,
    filters.yearFrom,
    filters.yearTo,
    filters.minRating,
    filters.sortBy,
  ], [filters]);

  // ── Search query ───────────────────────────────────────────────────────────
  const searchQuery = useInfiniteQuery({
    queryKey: ['search-multi', debouncedQuery],
    enabled: isSearching,
    initialPageParam: 1,
    queryFn: async ({ pageParam, signal }) => {
      const url = new URL(`${CONFIG.BASE_URL}/search/multi`);
      url.searchParams.append('language', 'fr-FR');
      url.searchParams.append('query', debouncedQuery);
      url.searchParams.append('page', pageParam);
      url.searchParams.append('include_adult', 'false');
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error('La recherche a échoué');
      const data = await res.json();
      return {
        results: (data.results ?? []).filter(i => ['movie', 'tv'].includes(i.media_type)),
        totalPages: data.total_pages,
      };
    },
    getNextPageParam,
  });

  // ── Browse query (filters active, no search text) ──────────────────────────
  const browseQuery = useInfiniteQuery({
    queryKey: browseQueryKey,
    enabled: isBrowsing,
    initialPageParam: 1,
    queryFn: async ({ pageParam, signal }) => {
      const url = buildBrowseUrl(pageParam);
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error('Le chargement du catalogue a échoué');
      const data = await res.json();
      const type = filters.mediaType === 'tv' ? 'tv' : 'movie';
      return {
        results: (data.results ?? []).map(i => ({ ...i, media_type: type })),
        totalPages: data.total_pages,
      };
    },
    getNextPageParam,
  });

  // ── Suggested (trending, no filters, no search) ────────────────────────────
  const suggestedQuery = useInfiniteQuery({
    queryKey: ['search-suggested-trending'],
    enabled: !isSearching && !isBrowsing,
    initialPageParam: 1,
    queryFn: async ({ pageParam, signal }) => {
      const url = new URL(`${CONFIG.BASE_URL}/trending/all/week`);
      url.searchParams.append('language', 'fr-FR');
      url.searchParams.append('page', pageParam);
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error('Le chargement a échoué');
      const data = await res.json();
      return {
        results: (data.results ?? []).filter(i => ['movie', 'tv'].includes(i.media_type)),
        totalPages: data.total_pages,
      };
    },
    getNextPageParam,
  });

  const activeQuery = isSearching ? searchQuery : isBrowsing ? browseQuery : suggestedQuery;
  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage, error } = activeQuery;
  const items = useMemo(() => {
    const normalized = normalizeItems(data?.pages ?? [], catalogue);
    if (!catalogue) return [];
    if (!isSearching) return normalized;
    const filtered = normalized.filter((item) => {
      const mediaType = item.media_type === 'tv' ? 'tv' : 'movie';
      if (filters.mediaType !== 'all' && mediaType !== filters.mediaType) return false;
      if (filters.genreId > 0 && !(item.genre_ids || []).includes(filters.genreId)) return false;
      if (filters.genreId < 0 && !matchesSpecialTheme(item, mediaType, filters.genreId)) return false;
      const year = Number(String(item.release_date || item.first_air_date || '').slice(0, 4));
      if (filters.yearFrom && (!year || year < Number(filters.yearFrom))) return false;
      if (filters.yearTo && (!year || year > Number(filters.yearTo))) return false;
      if (filters.minRating > 0 && Number(item.vote_average || 0) < filters.minRating) return false;
      return true;
    });
    const sorted = [...filtered];
    if (filters.sortBy === 'vote_average.desc') sorted.sort((a, b) => Number(b.vote_average || 0) - Number(a.vote_average || 0));
    else if (filters.sortBy === 'release_date.desc') sorted.sort((a, b) => String(b.release_date || b.first_air_date || '').localeCompare(String(a.release_date || a.first_air_date || '')));
    else if (filters.sortBy === 'release_date.asc') sorted.sort((a, b) => String(a.release_date || a.first_air_date || '').localeCompare(String(b.release_date || b.first_air_date || '')));
    else sorted.sort((a, b) => Number(b.popularity || 0) - Number(a.popularity || 0));
    return sorted;
  }, [data, filters, isSearching, catalogue]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && hasNextPage && !isFetchingNextPage) fetchNextPage();
      },
      { rootMargin: '220px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, items.length]);

  const matchedCategories = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return UNIQUE_CATEGORIES.filter(cat => cat.name.toLowerCase().includes(q));
  }, [query]);

  const clearQuery = () => {
    setQuery('');
    setDebouncedQuery('');
    inputRef.current?.focus();
  };

  const showInitialLoading = isLoading && items.length === 0;
  const showLoadingMore = isFetchingNextPage && items.length > 0;
  const gridAnimationKey = isSearching
    ? debouncedQuery.trim().toLowerCase()
    : isBrowsing
      ? JSON.stringify(filters)
      : 'trending';

  // Section heading
  let sectionHeading = null;
  if (isSearching) {
    sectionHeading = (
      <h2 className="text-sm text-gray-400">
        Résultats pour <span className="text-white font-semibold">« {debouncedQuery} »</span>
      </h2>
    );
  } else if (isBrowsing) {
    const parts = [];
    if (filters.mediaType !== 'all') parts.push(filters.mediaType === 'tv' ? 'Séries' : 'Films');
    if (filters.genreId !== null) {
      const g = genreList.find(x => x.id === filters.genreId);
      if (g) parts.push(g.name);
    }
    if (filters.yearFrom && filters.yearTo) parts.push(`${filters.yearFrom}–${filters.yearTo}`);
    else if (filters.yearFrom) parts.push(`Depuis ${filters.yearFrom}`);
    else if (filters.yearTo) parts.push(`Jusqu’à ${filters.yearTo}`);
    if (filters.minRating > 0) parts.push(`Note ${filters.minRating}+`);
    sectionHeading = (
      <h2 className="text-sm text-gray-400">
        Catalogue : <span className="text-white font-semibold">{parts.join(' · ') || 'Tous les contenus'}</span>
      </h2>
    );
  } else {
    sectionHeading = <h2 className="text-lg font-semibold">Tendances de la semaine</h2>;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
      className="min-h-screen bg-black text-white px-4 sm:px-8 pt-0 md:pt-10 pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-16"
    >
      <SEO
        title={debouncedQuery ? `« ${debouncedQuery} » — Résultats de recherche` : isCatalogue ? 'Catalogue de films et séries' : 'Rechercher des films et des séries'}
        description={
          debouncedQuery
            ? `Résultats de recherche pour « ${debouncedQuery} » sur WeFlix.`
            : isCatalogue
              ? 'Explorez le catalogue WeFlix par thème, type de contenu, année, note et popularité.'
              : 'Recherchez des films et des séries par genre, année et note sur WeFlix.'
        }
      />
      {/* Mobile-aware sticky top bar */}
      <div className="sticky top-0 z-40 -mx-4 sm:-mx-8 px-4 sm:px-8 pt-[calc(env(safe-area-inset-top)+0.75rem)] md:pt-0 pb-3 md:pb-0 backdrop-blur-md bg-black/80 md:bg-transparent border-b border-white/[0.06] md:border-none mb-4 md:mb-0">
        <h1 className="text-2xl sm:text-3xl font-bold md:hidden">{isCatalogue ? 'Catalogue' : 'Rechercher'}</h1>
      </div>
      <div className="hidden md:block mb-6">
        <p className="mb-2 text-xs font-bold uppercase tracking-[0.24em] text-red-400">Tout WeFlix, au même endroit</p>
        <h1 className="text-3xl font-bold">{isCatalogue ? 'Catalogue' : 'Rechercher'}</h1>
        {isCatalogue && <p className="mt-2 max-w-2xl text-sm text-gray-500">Choisissez d’abord un type de contenu, puis une ambiance. Les résultats se mettent à jour automatiquement.</p>}
      </div>

      {/* ── Compact quick-filter bar ── */}
      <div className="sticky top-[calc(env(safe-area-inset-top)+3.35rem)] md:top-0 z-30 -mx-4 sm:-mx-8 px-4 sm:px-8 py-3 border-y border-white/[0.06] bg-black/90 backdrop-blur-xl shadow-[0_14px_30px_rgba(0,0,0,0.25)]">
        <div className="flex flex-col gap-2.5 xl:flex-row xl:items-center">
          <div className="relative min-w-0 flex-1 xl:max-w-xl">
            <FaSearch className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 text-sm pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={isCatalogue ? 'Rechercher un titre…' : 'Rechercher des films, séries ou genres…'}
              className="w-full bg-[#11151e] border border-white/10 text-white pl-11 pr-10 py-3 rounded-xl text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-red-600/70 focus:border-red-500/40 placeholder-gray-600 transition-all"
            />
            {showInitialLoading && <div className="absolute right-10 top-1/2 -translate-y-1/2"><div className="w-4 h-4 border-2 border-red-600 border-t-transparent rounded-full animate-spin" /></div>}
            {query && <button type="button" onClick={clearQuery} className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-gray-500 hover:text-white" aria-label="Effacer la recherche"><FaTimes /></button>}
          </div>

          <div className="flex min-w-0 items-center gap-2 overflow-x-auto hide-scrollbar pb-0.5 xl:pb-0">
            <div className="flex shrink-0 rounded-xl border border-white/10 bg-[#11151e] p-1" aria-label="Type de contenu">
              {!isCatalogue && <button type="button" onClick={() => setFilter('mediaType', 'all')} className={`rounded-lg px-3 py-2 text-xs font-bold ${filters.mediaType === 'all' ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-white'}`}>Tous</button>}
              <button type="button" onClick={() => setFilter('mediaType', 'movie')} className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold ${filters.mediaType === 'movie' ? 'bg-red-600 text-white shadow-md shadow-red-950/40' : 'text-gray-500 hover:text-white'}`}><BiMoviePlay className="text-base" /> Films</button>
              <button type="button" onClick={() => setFilter('mediaType', 'tv')} className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold ${filters.mediaType === 'tv' ? 'bg-red-600 text-white shadow-md shadow-red-950/40' : 'text-gray-500 hover:text-white'}`}><BiTv className="text-base" /> Séries</button>
            </div>

            <label className="relative shrink-0">
              <span className="sr-only">Thème</span>
              <select value={filters.genreId ?? ''} onChange={(event) => setFilter('genreId', event.target.value === '' ? null : Number(event.target.value))} className="h-[46px] min-w-44 appearance-none rounded-xl border border-white/10 bg-[#11151e] pl-3 pr-9 text-xs font-bold text-gray-200 outline-none hover:border-white/20 focus:border-red-500/50">
                <option value="">Tous les thèmes</option>
                <optgroup label="Thèmes">
                  {genreList.filter((theme) => theme.id > 0).map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
                </optgroup>
                {filters.mediaType !== 'all' && <optgroup label="Sélections du monde">
                  {genreList.filter((theme) => theme.id < 0).map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
                </optgroup>}
              </select>
              <FaChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-gray-600" />
            </label>

            <label className="relative shrink-0">
              <span className="sr-only">Trier les résultats</span>
              <select value={filters.sortBy} onChange={(event) => setFilter('sortBy', event.target.value)} className="h-[46px] min-w-44 appearance-none rounded-xl border border-white/10 bg-[#11151e] pl-3 pr-9 text-xs font-bold text-gray-200 outline-none hover:border-white/20 focus:border-red-500/50">
                {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <FaChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-gray-600" />
            </label>

          </div>
        </div>

        {(activeTheme || filters.yearFrom || filters.yearTo || filters.minRating > 0) && <div className="mt-2.5 flex items-center gap-2 overflow-x-auto hide-scrollbar">
          <span className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-gray-600">Actifs</span>
          {activeTheme && <button type="button" onClick={() => setFilter('genreId', null)} className="filter-summary-chip">{activeTheme.name}<FaTimes /></button>}
          {(filters.yearFrom || filters.yearTo) && <button type="button" onClick={() => setFilters((current) => ({ ...current, yearFrom: '', yearTo: '' }))} className="filter-summary-chip">{filters.yearFrom && filters.yearTo ? `${filters.yearFrom}–${filters.yearTo}` : filters.yearFrom ? `Depuis ${filters.yearFrom}` : `Jusqu’à ${filters.yearTo}`}<FaTimes /></button>}
          {filters.minRating > 0 && <button type="button" onClick={() => setFilter('minRating', 0)} className="filter-summary-chip">Note {filters.minRating}+<FaTimes /></button>}
          <button type="button" onClick={resetFilters} className="shrink-0 px-2 py-1 text-[11px] font-semibold text-gray-500 hover:text-red-400">Tout effacer</button>
        </div>}
      </div>

      {error && <p className="mt-3 text-red-500 text-sm">{error.message}</p>}

      {/* ── Category shortcut chips (appear when typing a genre name) ── */}
      {matchedCategories.length > 0 && (
        <section className="mt-6">
          <div className="flex items-center gap-2 mb-3">
            <span className="w-1 h-5 bg-red-600 rounded-full inline-block" />
            <h2 className="text-sm font-semibold text-gray-300">Parcourir par catégorie</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            {matchedCategories.map(cat => (
              <button
                key={`${cat.mediaType}-${cat.id}`}
                onClick={() => navigate(cat.path)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-white/[0.07] border border-white/10 text-gray-300 hover:bg-red-600/20 hover:border-red-500/40 hover:text-white transition-all duration-150"
              >
                {cat.mediaType === 'movie'
                  ? <BiMoviePlay className="text-red-400 shrink-0" />
                  : <BiTv className="text-red-400 shrink-0" />}
                {cat.name}
                <span className="text-[10px] text-gray-600 ml-0.5">
                  {cat.mediaType === 'movie' ? 'Films' : 'Séries'}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* ── Results ── */}
      <section className="mt-6">
        <div className="flex items-center gap-2 mb-1">
          <span className="w-1 h-5 bg-red-600 rounded-full inline-block" />
          {sectionHeading}
        </div>

        {items.length === 0 && showInitialLoading && <SkeletonGrid />}

        {items.length === 0 && !showInitialLoading && isSearching && (
          <p className="text-gray-500 mt-8 text-sm">Aucun résultat pour « {debouncedQuery} »</p>
        )}

        {items.length === 0 && !showInitialLoading && isBrowsing && !isLoading && (
          <div className="mt-12 text-center">
            <BiSliderAlt className="text-gray-700 text-5xl mx-auto mb-4" />
            <p className="text-gray-500 text-sm">Aucun titre ne correspond à vos filtres.</p>
            <button onClick={resetFilters} className="mt-4 text-red-400 hover:text-red-300 text-sm font-semibold transition-colors">
              Effacer les filtres
            </button>
          </div>
        )}

        {items.length > 0 && (
          <div className={GRID_CLASSES}>
            {items.map((item, index) => (
              <motion.div
                key={`${gridAnimationKey}-${item.media_type || 'movie'}-${item.id}`}
                initial={{ opacity: 0, y: 12, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{
                  duration: 0.26,
                  ease: 'easeOut',
                  delay: Math.min(index, 14) * 0.018,
                }}
              >
                <ContentCard
                  title={item.title || item.name}
                  poster={item.poster_path ? `${CONFIG.IMAGE_BASE_URL}${item.poster_path}` : ''}
                  rating={item.vote_average}
                  releaseDate={item.release_date || item.first_air_date}
                  onClick={() => {
                    const type = item.media_type === 'tv' ? 'tv' : 'movie';
                    const from = `${location.pathname}${location.search}`;
                    navigate(toDetailPath(type, item.id, item.title || item.name), { state: { from } });
                  }}
                  mediaId={item.id}
                  mediaType={item.media_type === 'tv' ? 'tv' : 'movie'}
                  posterPath={item.poster_path}
                  voteAverage={item.vote_average}
                />
              </motion.div>
            ))}
          </div>
        )}

        <div ref={sentinelRef} />

        {showLoadingMore && (
          <div className="flex justify-center py-8">
            <div className="w-9 h-9 border-[3px] border-red-600 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </section>
    </motion.div>
  );
}

export default SearchPage;
