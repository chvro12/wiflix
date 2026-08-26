import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import ParentComponent from './pages/Home/ParentComponent';
import HomePage from './pages/Home/HomePage';
import Movie from './pages/Home/Movie/Movie';
import Series from './pages/Home/TV/Series';
import SearchPage from './pages/Home/SearchPage';
import MovieDetails from './pages/Home/Movie/MovieDetails';
import TvDetails from './pages/Home/TV/TvDetails';
import WatchlistPage from './pages/Home/WatchlistPage';
import ResetPasswordPage from './pages/Home/ResetPasswordPage';
import EmailVerificationPage from './pages/Home/EmailVerificationPage';
import PersonPage from './pages/Home/Person/PersonPage';
import AuthActionPage from './pages/Home/AuthActionPage';
import AccessPage from './pages/AccessPage';
import AdminPage from './pages/AdminPage';
import SiteAnalytics from './components/SiteAnalytics';

function App() {
  return (
    <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SiteAnalytics />
      <Routes>
        <Route path="/acces" element={<AccessPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route element={<ParentComponent />}>
          <Route index element={<HomePage />} />
          <Route path="/movies" element={<Movie />} />
          <Route path="/movies/:genreSlug" element={<Movie />} />
          <Route path="/movies/:genreSlug/:sortSlug" element={<Movie />} />
          <Route path="/series" element={<Series />} />
          <Route path="/series/:genreSlug" element={<Series />} />
          <Route path="/series/:genreSlug/:sortSlug" element={<Series />} />
          <Route path="/movies/watch/:slug" element={<MovieDetails />} />
          <Route path="/series/watch/:slug" element={<TvDetails />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/catalogue" element={<SearchPage />} />
          <Route path="/person/:id/:slug" element={<PersonPage />} />
          <Route path="/watchlist" element={<WatchlistPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/verify-email" element={<EmailVerificationPage />} />
          <Route path="/auth-action" element={<AuthActionPage />} />
          {/* Legacy detail URLs (auto-canonicalized in page components) */}
          <Route path="/movie/:slug" element={<MovieDetails />} />
          <Route path="/tv/:slug" element={<TvDetails />} />
        </Route>
      </Routes>
    </Router>
  );
}

export default App;
