import React, { useState, useEffect } from 'react';
import PropTypes from 'prop-types';
import {
  BiSearch,
  BiHomeAlt,
  BiMoviePlay,
  BiTv,
  BiGridAlt,
  BiBookmark
} from 'react-icons/bi';
import { FaPlay, FaSignOutAlt, FaUserCircle } from 'react-icons/fa';
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth } from "../../firebase";

const NAV_ITEMS = [
  { id: 'search', icon: BiSearch, action: 'navigate', label: 'Rechercher' },
  { id: 'home', icon: BiHomeAlt, action: 'navigate', label: 'Accueil' },
  { id: 'catalogue', icon: BiGridAlt, action: 'navigate', label: 'Catalogue' },
  { id: 'movies', icon: BiMoviePlay, action: 'navigate', label: 'Films' },
  { id: 'series', icon: BiTv, action: 'navigate', label: 'Séries' },
  { id: 'watchlist', icon: BiBookmark, action: 'navigate', label: 'Ma liste' },
];

// Read cached auth flag from localStorage for instant render
const getCachedUser = () => {
  try { return JSON.parse(localStorage.getItem('weflix_user')) ?? null; } catch { return null; }
};

function Sidebar({ activePage, onNavigate, onOpenAuthModal }) {
  const [user, setUser] = useState(getCachedUser);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (currentUser) {
        const cached = { uid: currentUser.uid, displayName: currentUser.displayName, email: currentUser.email };
        localStorage.setItem('weflix_user', JSON.stringify(cached));
      } else {
        localStorage.removeItem('weflix_user');
      }
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  const ACTIVE_MAP = { search: 'search', catalogue: 'catalogue', movies: 'movies', series: 'series', watchlist: 'watchlist', home: 'home' };
  const activeId = ACTIVE_MAP[activePage] ?? 'home';

  return (
    <aside className="
      group fixed top-0 left-0 h-full z-50
      hidden md:flex flex-col
      w-[84px] hover:w-[260px]
      bg-gray-900/95 backdrop-blur-xl
      border-r border-white/10
      shadow-2xl shadow-black/30
      overflow-hidden
      transition-[width] duration-300 ease-in-out
      select-none
    ">

      <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-red-500/10 to-transparent pointer-events-none" />

      {/* Logo */}
      <button onClick={() => onNavigate('home')} className="relative flex items-center gap-4 px-[18px] pt-8 pb-8 shrink-0 text-left hover:opacity-90 transition-opacity">
        <div className="flex items-center justify-center w-[48px] h-[48px] rounded-2xl bg-gradient-to-br from-red-500 to-red-700 shadow-lg shadow-red-900/40 ring-1 ring-white/10 shrink-0">
          <FaPlay className="text-white text-[15px] ml-0.5" />
        </div>
        <div className="flex flex-col leading-tight whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-200 delay-100">
          <span className="text-white font-black text-[20px] tracking-tight">WeFlix</span>
          <span className="text-red-400/70 text-[10px] font-semibold tracking-[0.22em] uppercase mt-0.5">Streaming</span>
        </div>
      </button>

      {/* Nav section label */}
      <div className="px-[18px] mb-1 shrink-0">
        <span className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 delay-75 text-[11px] font-bold tracking-[0.22em] uppercase text-gray-500 whitespace-nowrap">
          Menu
        </span>
      </div>

      {/* Nav items */}
      <nav className="flex flex-1 flex-col gap-1 px-[10px] pb-6">
        {NAV_ITEMS.map(({ id, icon: Icon, label }) => {
          const isActive = activeId === id;
          return (
            <button
              key={id}
              onClick={() => onNavigate(id)}
              title={label}
              className={`
                relative flex items-center gap-4 px-4 py-3.5 rounded-2xl
                w-full text-[14px] font-medium whitespace-nowrap
                border-2 transition-colors duration-200 focus:outline-none
                ${isActive
                  ? 'border-red-500/35 bg-red-500/15 text-white shadow-sm shadow-red-950/30'
                  : 'border-transparent text-gray-400 hover:text-white hover:bg-white/5 hover:border-transparent'
                }
              `}
            >
              <Icon className={`text-[24px] shrink-0 transition-colors duration-200 ${isActive ? 'text-red-400' : ''}`} />
              <span className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 delay-75">
                {label}
              </span>
            </button>
          );
        })}
      </nav>

      <div className="h-6 shrink-0" />

      {/* User profile / Logout */}
      <div className="mt-auto pt-4 pb-6 px-[10px] shrink-0 border-t border-white/5 relative z-10 bg-gray-900/95">
        {user ? (
          <button
            onClick={handleLogout}
            title="Se déconnecter"
            className="
              relative flex items-center gap-4 px-4 py-3.5 rounded-2xl
              w-full whitespace-nowrap
              border-2 border-transparent text-gray-400 hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/20 transition-colors duration-200 focus:outline-none group/user
            "
          >
            <FaSignOutAlt className="text-[24px] shrink-0" />
            <div className="flex flex-col text-left opacity-0 group-hover:opacity-100 transition-opacity duration-200 delay-75">
              <span className="text-white line-clamp-1 text-[13px] font-bold">{user.displayName || user.email?.split('@')[0]}</span>
              <span className="text-red-400 text-[10px] font-bold uppercase tracking-wider">Se déconnecter</span>
            </div>
          </button>
        ) : (
          <button
            onClick={onOpenAuthModal}
            title="Se connecter"
            className="
              relative flex items-center gap-4 px-4 py-3.5 rounded-2xl
              w-full text-[14px] font-medium whitespace-nowrap
              border-2 border-transparent text-gray-400 hover:text-white hover:bg-white/5 hover:border-transparent transition-colors duration-200 focus:outline-none
            "
          >
            <FaUserCircle className="text-[24px] shrink-0" />
            <span className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 delay-75 w-24 overflow-hidden">
              Se connecter
            </span>
          </button>
        )}
      </div>
    </aside>
  );
}

Sidebar.propTypes = {
  activePage: PropTypes.string.isRequired,
  onNavigate: PropTypes.func.isRequired,
  onOpenAuthModal: PropTypes.func
};

export default React.memo(Sidebar);
