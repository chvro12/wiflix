import React, { useState, useEffect, useRef, useCallback } from 'react';
import { BiChevronLeft, BiChevronRight } from 'react-icons/bi';
import { collection, query, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';
import { auth, db } from '../../firebase';
import ContentCard from './ContentCard';
import { fetchR2Catalogue, isR2Streamable } from '../../utils/r2Catalogue';

const POSTER = 'https://image.tmdb.org/t/p/w500';

export default function ContinueWatchingRow({ onSelect, accent }) {
  const [items, setItems] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('wf_cw_cache_items') || '[]');
    } catch {
      return [];
    }
  });
  const [user, setUser] = useState(null);
  const [visibleItems, setVisibleItems] = useState([]);
  const rowRef = useRef(null);
  const dragStateRef = useRef({ active: false, startX: 0, startScrollLeft: 0, moved: false });
  const suppressClickRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);

  // Track auth
  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (!u) {
        setItems([]);
        localStorage.removeItem('wf_cw_cache_items');
      }
    });
  }, []);

  // Sync from Firestore
  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, 'users', user.uid, 'continue_watching'),
      orderBy('updatedAt', 'desc'),
      limit(20)
    );
    const unsub = onSnapshot(q, (snapshot) => {
      const data = [];
      snapshot.forEach(doc => data.push(doc.data()));
      setItems(data);
      try {
        localStorage.setItem('wf_cw_cache_items', JSON.stringify(data));
      } catch (e) {
        // limit reached
      }
    });
    return unsub;
  }, [user]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!items.length) {
        if (!cancelled) setVisibleItems([]);
        return;
      }
      try {
        const catalogue = await fetchR2Catalogue();
        const filtered = items.filter((item) => isR2Streamable(
          { id: item.id, media_type: item.mediaType },
          item.mediaType,
          catalogue,
        ));
        if (!cancelled) setVisibleItems(filtered);
      } catch {
        if (!cancelled) setVisibleItems([]);
      }
    })();
    return () => { cancelled = true; };
  }, [items]);

  const scroll = (dir) => {
    const el = rowRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * 580, behavior: 'smooth' });
  };

  const onRowMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    const el = rowRef.current;
    if (!el) return;

    dragStateRef.current = {
      active: true,
      startX: e.pageX,
      startScrollLeft: el.scrollLeft,
      moved: false,
    };
    setIsDragging(true);
  }, []);

  const onRowMouseMove = useCallback((e) => {
    const el = rowRef.current;
    const drag = dragStateRef.current;
    if (!el || !drag.active) return;

    const delta = e.pageX - drag.startX;
    if (Math.abs(delta) > 4) drag.moved = true;
    el.scrollLeft = drag.startScrollLeft - delta;
  }, []);

  const endRowDrag = useCallback(() => {
    const drag = dragStateRef.current;
    if (!drag.active) return;

    drag.active = false;
    suppressClickRef.current = drag.moved;
    setIsDragging(false);

    setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  }, []);

  useEffect(() => {
    window.addEventListener('mouseup', endRowDrag);
    return () => window.removeEventListener('mouseup', endRowDrag);
  }, [endRowDrag]);

  if (!visibleItems.length) return null;

  return (
    <section className="mb-12 group/row" style={{ overflow: 'visible' }}>
      {/* ── Section header ── */}
      <div className="flex items-center justify-between px-4 sm:px-6 mb-5">
        <div className="flex items-center">
          <h2 className="text-white font-bold text-lg md:text-xl tracking-tight">Reprendre la lecture</h2>
        </div>
        <div className="flex items-center gap-2">
          {/* Nav arrows */}
          <div className="flex items-center gap-1 opacity-40 group-hover/row:opacity-100 transition-opacity duration-200">
            <button
              onClick={() => scroll(-1)}
              className="w-8 h-8 rounded-full bg-white/[0.08] hover:bg-white/20 flex items-center justify-center text-white transition-colors"
            >
              <BiChevronLeft className="text-xl" />
            </button>
            <button
              onClick={() => scroll(1)}
              className="w-8 h-8 rounded-full bg-white/[0.08] hover:bg-white/20 flex items-center justify-center text-white transition-colors"
            >
              <BiChevronRight className="text-xl" />
            </button>
          </div>
        </div>
      </div>

      {/* ── Card row ── */}
      <div
        ref={rowRef}
        onMouseDown={onRowMouseDown}
        onMouseMove={onRowMouseMove}
        onMouseLeave={endRowDrag}
        className={`flex gap-3 overflow-x-auto hide-scrollbar px-4 sm:px-6 select-none ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        style={{ paddingTop: 24, paddingBottom: 24, marginTop: -16, marginBottom: -16 }}
      >
        {visibleItems.map((item) => {
          const releaseDate = item.release_date || '';
          const isTv = item.mediaType === 'tv';
          return (
            <div
              key={item.id}
              className="shrink-0 relative"
              style={{ width: 160 }}
            >
              <ContentCard
                title={item.title}
                poster={item.poster_path ? `${POSTER}${item.poster_path}` : null}
                rating={item.vote_average}
                releaseDate={releaseDate.slice(0, 4)}
                onClick={() => {
                  if (suppressClickRef.current) return;
                  onSelect(item, item.mediaType);
                }}
                mediaId={item.id}
                mediaType={item.mediaType}
                posterPath={item.poster_path}
                voteAverage={item.vote_average}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
