import { useEffect, useState } from 'react';
import { FaArrowRight, FaPlay, FaShieldAlt } from 'react-icons/fa';
import { Link } from 'react-router-dom';
import { EDGE_API_URL } from '../utils/analytics';

export default function AccessPage() {
  const [settings, setSettings] = useState({ destinationUrl: '', buttonLabel: 'Accéder au site', configured: false });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${EDGE_API_URL}/api/site-settings`)
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then(setSettings)
      .catch(() => setSettings((current) => ({ ...current, configured: false })))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#05070c] px-5 py-12 text-white">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_20%,rgba(239,68,68,0.23),transparent_38%),linear-gradient(to_bottom,transparent,#05070c_75%)]" />
      <div className="pointer-events-none absolute -left-32 top-1/2 h-72 w-72 rounded-full bg-red-700/10 blur-3xl" />
      <div className="pointer-events-none absolute -right-32 top-1/3 h-80 w-80 rounded-full bg-red-500/10 blur-3xl" />

      <section className="relative w-full max-w-2xl text-center">
        <Link to="/" className="mx-auto mb-9 flex w-fit items-center gap-3 transition-transform hover:scale-[1.02]">
          <span className="flex h-16 w-16 items-center justify-center rounded-[1.4rem] bg-gradient-to-br from-red-500 to-red-700 shadow-2xl shadow-red-950/60 ring-1 ring-white/10">
            <FaPlay className="ml-1 text-xl" />
          </span>
          <span className="text-3xl font-black tracking-tight">We<span className="text-red-500">Flix</span></span>
        </Link>

        <div className="rounded-[2rem] border border-white/10 bg-gray-900/60 px-6 py-10 shadow-2xl shadow-black/60 backdrop-blur-xl sm:px-12 sm:py-14">
          <div className="mx-auto mb-6 flex h-11 w-11 items-center justify-center rounded-full border border-emerald-400/20 bg-emerald-400/10 text-emerald-400">
            <FaShieldAlt />
          </div>
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.3em] text-red-400">Votre espace streaming</p>
          <h1 className="text-4xl font-black leading-tight tracking-tight sm:text-6xl">Tout votre contenu.<br /><span className="text-gray-400">Au même endroit.</span></h1>
          <p className="mx-auto mt-6 max-w-lg text-sm leading-6 text-gray-400 sm:text-base">Films et séries réunis dans une expérience fluide, personnelle et pensée pour tous vos écrans.</p>

          {loading ? (
            <div className="mx-auto mt-9 h-14 w-full max-w-sm animate-pulse rounded-2xl bg-white/10" />
          ) : settings.configured ? (
            <a href={settings.destinationUrl} className="group mx-auto mt-9 flex w-full max-w-sm items-center justify-center gap-3 rounded-2xl bg-gradient-to-r from-red-500 to-red-600 px-6 py-4 font-black shadow-xl shadow-red-950/50 transition hover:-translate-y-0.5 hover:from-red-400 hover:to-red-500">
              {settings.buttonLabel} <FaArrowRight className="transition-transform group-hover:translate-x-1" />
            </a>
          ) : (
            <div className="mx-auto mt-9 max-w-sm rounded-2xl border border-amber-400/20 bg-amber-400/10 px-5 py-4 text-sm text-amber-200">Le portail n’a pas encore été configuré.</div>
          )}
        </div>
        <p className="mt-6 text-xs text-gray-600">Accès sécurisé · WeFlix {new Date().getFullYear()}</p>
      </section>
    </main>
  );
}
