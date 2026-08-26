import { useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { FaArrowLeft, FaChartLine, FaCheckCircle, FaClock, FaEye, FaFilm, FaLock, FaPauseCircle, FaPlay, FaSave, FaSpinner, FaSyncAlt, FaTv, FaUserFriends, FaUsers } from 'react-icons/fa';
import { Link } from 'react-router-dom';
import { EDGE_API_URL, loadAdminAnalytics } from '../utils/analytics';

const emptyForm = { destinationUrl: '', buttonLabel: 'Accéder au site' };
const emptyTotals = { usersObserved: 0, online: 0, watching: 0, pageViews: 0, playbackStarts: 0, completions: 0, watchSeconds: 0, movies: 0, series: 0, episodes: 0 };
const number = new Intl.NumberFormat('fr-FR');
const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
const duration = (seconds = 0) => {
  const hours = Math.floor(Number(seconds) / 3600);
  const minutes = Math.floor((Number(seconds) % 3600) / 60);
  return hours ? `${number.format(hours)} h ${minutes} min` : `${minutes} min`;
};
const date = (value) => value ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';
const ago = (value) => {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value || 0)) / 1000));
  if (seconds < 60) return `il y a ${seconds} s`;
  if (seconds < 3600) return `il y a ${Math.floor(seconds / 60)} min`;
  return `il y a ${Math.floor(seconds / 3600)} h`;
};

const StatCard = ({ icon: Icon, label, value, detail, color = 'text-red-400 bg-red-500/10 ring-red-500/20' }) => (
  <article className="rounded-3xl border border-white/10 bg-gray-900/70 p-5 shadow-xl shadow-black/20">
    <div className={`mb-5 flex h-11 w-11 items-center justify-center rounded-2xl ring-1 ${color}`}><Icon /></div>
    <p className="text-3xl font-black tracking-tight">{value}</p><p className="mt-1 text-sm font-bold text-gray-300">{label}</p><p className="mt-1 text-xs text-gray-500">{detail}</p>
  </article>
);

export default function AdminDashboard() {
  const [form, setForm] = useState(emptyForm);
  const [password, setPassword] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    fetch(`${EDGE_API_URL}/api/site-settings`).then((response) => response.ok ? response.json() : Promise.reject())
      .then((settings) => setForm({ destinationUrl: settings.destinationUrl || '', buttonLabel: settings.buttonLabel || 'Accéder au site' })).catch(() => null);
  }, []);

  const refresh = useCallback(async (adminPassword = password, silent = false) => {
    if (!adminPassword) return;
    if (!silent) setLoading(true);
    try {
      setDashboard(await loadAdminAnalytics(adminPassword)); setUnlocked(true); setMessage(null);
    } catch (error) {
      if (!silent) setMessage({ type: 'error', text: error.message });
      if (/mot de passe/i.test(error.message)) setUnlocked(false);
    } finally { if (!silent) setLoading(false); }
  }, [password]);

  useEffect(() => {
    if (!unlocked) return undefined;
    const timer = window.setInterval(() => refresh(password, true), 15_000);
    return () => window.clearInterval(timer);
  }, [password, refresh, unlocked]);

  const saveSettings = async (event) => {
    event.preventDefault(); setSaving(true); setMessage(null);
    try {
      const response = await fetch(`${EDGE_API_URL}/api/site-settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Admin-Password': password }, body: JSON.stringify(form) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Enregistrement impossible');
      setForm({ destinationUrl: result.destinationUrl, buttonLabel: result.buttonLabel });
      setMessage({ type: 'success', text: 'Configuration enregistrée.' });
    } catch (error) { setMessage({ type: 'error', text: error.message }); }
    finally { setSaving(false); }
  };

  const totals = dashboard?.totals || emptyTotals;
  const maxViews = useMemo(() => Math.max(1, ...(dashboard?.topMedia || []).map((item) => Number(item.views || 0))), [dashboard]);

  return <main className="relative min-h-screen overflow-hidden bg-[#05070c] px-4 py-7 text-white sm:px-8">
    <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_12%_5%,rgba(239,68,68,.16),transparent_32%),radial-gradient(circle_at_90%_60%,rgba(37,99,235,.08),transparent_30%)]" />
    <div className="relative mx-auto max-w-7xl">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <Link to="/" className="flex items-center gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-red-500 to-red-700"><FaPlay className="ml-0.5 text-sm" /></span><span className="text-xl font-black">We<span className="text-red-500">Flix</span> <small className="ml-2 font-medium text-gray-500">Admin</small></span></Link>
        <div className="flex gap-2">{unlocked && <button type="button" onClick={() => refresh()} className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-bold"><FaSyncAlt className={loading ? 'animate-spin' : ''} /> Actualiser</button>}<Link to="/" className="flex items-center gap-2 px-3 py-2 text-sm text-gray-400"><FaArrowLeft /> Site</Link></div>
      </header>

      {!unlocked ? <section className="mx-auto mt-20 max-w-md rounded-[2rem] border border-white/10 bg-gray-900/80 p-8 shadow-2xl">
        <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/10 text-red-400 ring-1 ring-red-500/20"><FaLock /></div><h1 className="text-2xl font-black">Tableau de bord</h1><p className="mt-2 text-sm leading-6 text-gray-400">Saisissez le mot de passe administrateur pour consulter les données privées.</p>
        <form className="mt-7 space-y-4" onSubmit={(event) => { event.preventDefault(); refresh(password); }}><input type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Mot de passe administrateur" className="w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3.5 outline-none focus:border-red-500/60" />{message?.type === 'error' && <p className="text-sm text-red-400">{message.text}</p>}<button disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-red-600 px-5 py-3.5 font-black">{loading ? <FaSpinner className="animate-spin" /> : <FaChartLine />} Ouvrir les statistiques</button></form>
      </section> : <div className="space-y-8">
        <section><div className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-[.24em] text-red-400">Vue d’ensemble</p><h1 className="mt-2 text-3xl font-black sm:text-4xl">Activité WeFlix</h1></div><p className="text-xs text-gray-500">Actualisation toutes les 15 secondes · {date(dashboard?.generatedAt)}</p></div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard icon={FaUsers} label="En ligne maintenant" value={number.format(totals.online)} detail="Actifs depuis moins de 90 secondes" color="text-emerald-400 bg-emerald-500/10 ring-emerald-500/20" />
            <StatCard icon={FaPlay} label="En cours de visionnage" value={number.format(totals.watching)} detail="Sessions actives en ce moment" />
            <StatCard icon={FaUserFriends} label="Utilisateurs observés" value={number.format(totals.usersObserved)} detail="Comptes ayant utilisé WeFlix" color="text-blue-400 bg-blue-500/10 ring-blue-500/20" />
            <StatCard icon={FaEye} label="Lectures lancées" value={compact.format(totals.playbackStarts)} detail={`${number.format(totals.completions)} terminées`} color="text-violet-400 bg-violet-500/10 ring-violet-500/20" />
            <StatCard icon={FaClock} label="Temps regardé" value={duration(totals.watchSeconds)} detail="Durée cumulée mesurée" color="text-amber-400 bg-amber-500/10 ring-amber-500/20" />
            <StatCard icon={FaChartLine} label="Pages consultées" value={compact.format(totals.pageViews)} detail="Membres connectés" color="text-blue-400 bg-blue-500/10 ring-blue-500/20" />
            <StatCard icon={FaFilm} label="Films disponibles" value={number.format(totals.movies)} detail="Prêts sur R2" />
            <StatCard icon={FaTv} label="Séries disponibles" value={number.format(totals.series)} detail={`${number.format(totals.episodes)} épisodes prêts`} color="text-emerald-400 bg-emerald-500/10 ring-emerald-500/20" />
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-[1.15fr_.85fr]">
          <Panel title="Visionnages en direct" subtitle="Position et progression actuelles" live>
            {(dashboard?.watching || []).length ? <div className="space-y-3">{dashboard.watching.map((item) => <div key={item.userId} className="rounded-2xl border border-white/5 bg-black/20 p-4"><div className="flex justify-between gap-3"><div className="min-w-0"><p className="truncate font-bold">{item.title || item.lookupPath}</p><p className="mt-1 truncate text-xs text-gray-500">{item.displayName || item.email} · {ago(item.lastSeenAt)}</p></div><span className="text-sm font-black text-red-400">{number.format(item.progress || 0)} %</span></div><div className="mt-3 h-1.5 rounded-full bg-white/10"><div className="h-full rounded-full bg-red-500" style={{ width: `${Math.max(1, item.progress || 0)}%` }} /></div></div>)}</div> : <Empty icon={FaPauseCircle} text="Personne ne regarde de contenu actuellement." />}
          </Panel>
          <Panel title="Présence sur le site" subtitle="Membres actifs, toutes pages confondues">
            {(dashboard?.online || []).length ? <div className="space-y-3">{dashboard.online.map((item) => <div key={item.userId} className="flex items-center gap-3 rounded-2xl bg-black/20 p-3"><span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/5 font-black">{(item.displayName || item.email || '?')[0].toUpperCase()}<i className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-gray-900 bg-emerald-400" /></span><div className="min-w-0"><p className="truncate text-sm font-bold">{item.displayName || item.email}</p><p className="truncate text-xs text-gray-500">{item.path || '/'} · {ago(item.lastSeenAt)}</p></div></div>)}</div> : <Empty icon={FaUsers} text="Aucun utilisateur actif." />}
          </Panel>
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <Panel title="Contenus les plus regardés" subtitle="Classement par nombre de démarrages">{(dashboard?.topMedia || []).length ? <div className="space-y-4">{dashboard.topMedia.slice(0, 10).map((item, index) => <div key={item.lookupPath}><div className="mb-2 flex gap-3"><span className="w-5 text-xs font-black text-gray-600">{index + 1}</span><p className="min-w-0 flex-1 truncate text-sm font-bold">{item.title}</p><span className="text-xs text-gray-400">{number.format(item.views || 0)} vues</span></div><div className="ml-8 h-1.5 rounded-full bg-white/5"><div className="h-full rounded-full bg-red-500" style={{ width: `${Math.max(2, Number(item.views || 0) / maxViews * 100)}%` }} /></div></div>)}</div> : <Empty icon={FaFilm} text="Le classement apparaîtra après les premières lectures." />}</Panel>
          <Panel title="Activité récente" subtitle="Visites et événements de lecture"><div className="max-h-[430px] space-y-2 overflow-y-auto">{(dashboard?.recentActivity || []).length ? dashboard.recentActivity.map((item, index) => <div key={`${item.createdAt}-${index}`} className="flex gap-3 rounded-2xl bg-black/20 p-3"><span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${item.type === 'playback_start' ? 'bg-red-500' : item.type === 'playback_complete' ? 'bg-emerald-500' : 'bg-blue-500'}`} /><div className="min-w-0"><p className="truncate text-sm"><b>{item.displayName || item.email}</b> · {{ page_view: 'Visite', playback_start: 'Lecture lancée', playback_complete: 'Lecture terminée' }[item.type]}</p><p className="truncate text-xs text-gray-500">{item.title || item.path || 'WeFlix'} · {ago(item.createdAt)}</p></div></div>) : <Empty icon={FaChartLine} text="Aucune activité enregistrée." />}</div></Panel>
        </div>

        <section className="overflow-hidden rounded-3xl border border-white/10 bg-gray-900/70"><div className="border-b border-white/10 px-6 py-5"><h2 className="text-xl font-black">Utilisateurs récents</h2><p className="text-xs text-gray-500">Comptes observés depuis l’activation des statistiques</p></div><div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left text-sm"><thead className="bg-black/20 text-xs uppercase text-gray-500"><tr><th className="px-6 py-3">Utilisateur</th><th className="px-4 py-3">Dernière activité</th><th className="px-4 py-3">Pages</th><th className="px-4 py-3">Lectures</th><th className="px-4 py-3">Temps</th></tr></thead><tbody className="divide-y divide-white/5">{(dashboard?.users || []).map((item) => <tr key={item.userId}><td className="px-6 py-4"><b>{item.displayName || 'Utilisateur'}</b><p className="text-xs text-gray-500">{item.email}</p></td><td className="px-4 py-4 text-gray-400">{date(item.lastSeenAt)}</td><td className="px-4 py-4">{number.format(item.pageViews || 0)}</td><td className="px-4 py-4">{number.format(item.playbackStarts || 0)}</td><td className="px-4 py-4">{duration(item.watchSeconds)}</td></tr>)}</tbody></table></div></section>

        <section className="rounded-3xl border border-white/10 bg-gray-900/70 p-6"><h2 className="text-xl font-black">Configuration du portail</h2><p className="mb-5 text-xs text-gray-500">Destination du bouton de la page d’accès</p><form onSubmit={saveSettings} className="grid gap-4 md:grid-cols-[1fr_.6fr_auto] md:items-end"><Field label="URL de destination"><input type="url" required value={form.destinationUrl} onChange={(event) => setForm((current) => ({ ...current, destinationUrl: event.target.value }))} className="admin-input" /></Field><Field label="Texte du bouton"><input required maxLength={60} value={form.buttonLabel} onChange={(event) => setForm((current) => ({ ...current, buttonLabel: event.target.value }))} className="admin-input" /></Field><button disabled={saving} className="flex items-center justify-center gap-2 rounded-xl bg-red-600 px-5 py-3 font-black"><FaSave /> {saving ? 'Enregistrement…' : 'Enregistrer'}</button></form>{message && <p className={`mt-4 flex items-center gap-2 text-sm ${message.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>{message.type === 'success' && <FaCheckCircle />}{message.text}</p>}</section>
      </div>}
    </div>
  </main>;
}

const Panel = ({ title, subtitle, live, children }) => <section className="rounded-3xl border border-white/10 bg-gray-900/70 p-6"><div className="mb-5 flex justify-between"><div><h2 className="text-xl font-black">{title}</h2><p className="text-xs text-gray-500">{subtitle}</p></div>{live && <span className="h-fit rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-bold text-emerald-400">● DIRECT</span>}</div>{children}</section>;
const Empty = ({ icon: Icon, text }) => <div className="flex min-h-40 flex-col items-center justify-center text-center text-gray-500"><Icon className="mb-3 text-3xl" /><p className="text-sm">{text}</p></div>;
const Field = ({ label, children }) => <label><span className="mb-2 block text-xs font-bold text-gray-400">{label}</span>{children}</label>;

StatCard.propTypes = { icon: PropTypes.elementType.isRequired, label: PropTypes.string.isRequired, value: PropTypes.node.isRequired, detail: PropTypes.string.isRequired, color: PropTypes.string };
Panel.propTypes = { title: PropTypes.string.isRequired, subtitle: PropTypes.string.isRequired, live: PropTypes.bool, children: PropTypes.node.isRequired };
Empty.propTypes = { icon: PropTypes.elementType.isRequired, text: PropTypes.string.isRequired };
Field.propTypes = { label: PropTypes.string.isRequired, children: PropTypes.node.isRequired };
