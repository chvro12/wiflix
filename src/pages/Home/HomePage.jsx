import { useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { toDetailPath } from './urlUtils';
import HeroBanner from './HeroBanner';
import TrendingRow from './TrendingRow';
import ContinueWatchingRow from './ContinueWatchingRow';
import PersonalizedRow from './PersonalizedRow';
import SEO from './SEO';

const SectionDivider = ({ label }) => (
  <div className="flex items-center gap-4 px-4 sm:px-6 mb-8 mt-4">
    <div className="flex-1 h-px bg-white/[0.05]" />
    <span className="text-gray-600 text-[11px] font-bold uppercase tracking-[0.25em]">{label}</span>
    <div className="flex-1 h-px bg-white/[0.05]" />
  </div>
);

export default function HomePage() {
  const navigate = useNavigate();
  const location = useLocation();

  const handleSelect = (item, type) => {
    const mediaType = item.media_type ?? type;
    const pathname = toDetailPath(mediaType === 'tv' ? 'tv' : 'movie', item.id, item.title || item.name);
    
    let search = '';
    if (mediaType === 'tv' && item.season && item.episode) {
      search = `?season=${item.season}&episode=${item.episode}`;
    }

    navigate(
      { pathname, search },
      { state: { from: location.pathname + location.search } }
    );
  };

  const goMovies = () => navigate('/movies');
  const goSeries = () => navigate('/series');

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
      className="bg-[#0a0c12] min-h-screen"
    >
      <SEO
        title="WeFlix — Films et séries en streaming"
        description="Découvrez les films et séries populaires, parcourez les genres et retrouvez les nouveautés sur WeFlix."
        noSuffix
      />
      
      {/* ── Visually Hidden H1 for SEO (Brand Keyword 'WeFlix') ── */}
      <h1 className="sr-only">WeFlix — Plateforme de films et séries</h1>

      <HeroBanner />

      <div className="pt-10 pb-8">
        <ContinueWatchingRow onSelect={handleSelect} />
        <PersonalizedRow onSelect={handleSelect} />

        {/* ── Movies ── */}
        <TrendingRow
          title="Films tendance"
          type="movie"
          variant="trending"
          accent="#ef4444"
          onSelect={handleSelect}
          onSeeAll={goMovies}
        />
        <TrendingRow
          title="Top 10 des films cette semaine"
          type="movie"
          variant="popular"
          showRank
          originalLanguage={['en', 'zh', 'ko', 'ja']}
          accent="#ef4444"
          onSelect={handleSelect}
          onSeeAll={goMovies}
        />
        <TrendingRow
          title="Nouveautés sorties récemment"
          type="movie"
          variant="now_playing"
          accent="#f59e0b"
          onSelect={handleSelect}
          onSeeAll={goMovies}
        />
        <TrendingRow
          title="Bientôt disponibles"
          type="movie"
          variant="upcoming"
          accent="#38bdf8"
          onSelect={handleSelect}
        />

        <SectionDivider label="Séries" />

        {/* ── TV ── */}
        <TrendingRow
          title="Séries asiatiques"
          type="tv"
          variant="popular"
          originalLanguage={['ko', 'ja', 'zh']}
          sinceYear={2020}
          accent="#f97316"
          onSelect={handleSelect}
          onSeeAll={goSeries}
        />
        <TrendingRow
          title="Séries tendance"
          type="tv"
          variant="trending"
          accent="#8b5cf6"
          onSelect={handleSelect}
          onSeeAll={goSeries}
        />
        <TrendingRow
          title="Top 10 des séries cette semaine"
          type="tv"
          variant="trending"
          showRank
          accent="#8b5cf6"
          onSelect={handleSelect}
          onSeeAll={goSeries}
        />
      </div>
    </motion.div>
  );
}
