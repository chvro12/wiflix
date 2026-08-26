import { useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import {
  FaArrowLeft, FaChartBar, FaCheckCircle, FaClock, FaDatabase,
  FaExclamationTriangle, FaEye, FaFilm, FaHistory, FaLock, FaPauseCircle,
  FaPlay, FaSave, FaSearch, FaServer, FaSignOutAlt, FaSpinner, FaSyncAlt,
  FaTasks, FaTv, FaUser, FaUsers,
} from 'react-icons/fa';
import { Link } from 'react-router-dom';
import { createAdminSession, EDGE_API_URL, loadAdminAnalytics } from '../utils/analytics';

const formatter = new Intl.NumberFormat('fr-FR');
const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
const initialTotals = { online: 0, watching: 0, usersObserved: 0, pageViews: 0, playbackStarts: 0, completions: 0, watchSeconds: 0, movies: 0, series: 0, episodes: 0, pending: 0, unavailable: 0, invalidManifests: 0 };
const tabs = [
  ['overview', 'Vue d’ensemble', FaChartBar], ['users', 'Utilisateurs', FaUsers],
  ['catalogue', 'Catalogue', FaFilm], ['activity', 'Activité', FaHistory], ['system', 'Système', FaServer],
];
const catalogueTabs = [['movies', 'Films'], ['series', 'Séries'], ['episodes', 'Épisodes'], ['pending', 'En attente'], ['unavailable', 'Indisponibles'], ['invalid', 'Incomplets']];
const ADMIN_SESSION_KEY = 'weflix_admin_session';
const ADMIN_VIEW_KEY = 'weflix_admin_view';

const storedSession = () => {
  try { return window.sessionStorage.getItem(ADMIN_SESSION_KEY) || ''; } catch { return ''; }
};
const storedView = () => {
  try { return JSON.parse(window.localStorage.getItem(ADMIN_VIEW_KEY) || '{}'); } catch { return {}; }
};

const formatDuration = (seconds = 0) => {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours ? `${formatter.format(hours)} h ${minutes} min` : `${minutes} min`;
};
const formatLatency = (seconds) => Number.isFinite(Number(seconds)) ? `${Math.round(Number(seconds))} s` : '—';
const formatDate = (value) => value ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
const formatAgo = (value) => {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value || 0)) / 1000));
  if (seconds < 60) return `il y a ${seconds} s`;
  if (seconds < 3600) return `il y a ${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `il y a ${Math.floor(seconds / 3600)} h`;
  return `il y a ${Math.floor(seconds / 86400)} j`;
};
const eventText = { page_view: 'a consulté une page', playback_start: 'a lancé une lecture', playback_complete: 'a terminé une lecture' };

const Card = ({ icon: Icon, label, value, detail, color = 'red' }) => {
  const colors = { red: 'bg-red-500/10 text-red-400 ring-red-500/20', green: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20', blue: 'bg-blue-500/10 text-blue-400 ring-blue-500/20', amber: 'bg-amber-500/10 text-amber-400 ring-amber-500/20', purple: 'bg-violet-500/10 text-violet-400 ring-violet-500/20' };
  return <article className="rounded-2xl border border-white/10 bg-[#0d111b]/90 p-5"><span className={`mb-4 flex h-10 w-10 items-center justify-center rounded-xl ring-1 ${colors[color]}`}><Icon /></span><p className="text-3xl font-black">{value}</p><p className="mt-1 text-sm font-bold text-gray-300">{label}</p><p className="mt-1 text-xs text-gray-500">{detail}</p></article>;
};

const Panel = ({ title, subtitle, action, children, className = '' }) => <section className={`rounded-2xl border border-white/10 bg-[#0d111b]/90 ${className}`}><div className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4"><div><h2 className="font-black">{title}</h2>{subtitle && <p className="mt-1 text-xs text-gray-500">{subtitle}</p>}</div>{action}</div><div className="p-5">{children}</div></section>;
const Empty = ({ icon: Icon = FaDatabase, children }) => <div className="flex min-h-36 flex-col items-center justify-center text-center text-gray-500"><Icon className="mb-3 text-3xl" /><p className="max-w-md text-sm">{children}</p></div>;
const Badge = ({ color = 'gray', children }) => { const colors = { gray: 'bg-white/5 text-gray-400', green: 'bg-emerald-500/10 text-emerald-400', red: 'bg-red-500/10 text-red-400', amber: 'bg-amber-500/10 text-amber-400', blue: 'bg-blue-500/10 text-blue-400' }; return <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${colors[color]}`}>{children}</span>; };

export default function AdminDashboardV2() {
  const initialView = useMemo(storedView, []);
  const [credentials, setCredentials] = useState({ username: initialView.username || 'admin', password: '' });
  const [sessionToken, setSessionToken] = useState(storedSession);
  const [authenticated, setAuthenticated] = useState(() => Boolean(storedSession()));
  const [dashboard, setDashboard] = useState(null);
  const [activeTab, setActiveTab] = useState(() => tabs.some(([id]) => id === initialView.activeTab) ? initialView.activeTab : 'overview');
  const [catalogueTab, setCatalogueTab] = useState(() => catalogueTabs.some(([id]) => id === initialView.catalogueTab) ? initialView.catalogueTab : 'movies');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState({ destinationUrl: '', buttonLabel: 'Accéder au site' });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async (silent = false) => {
    if (!sessionToken) return;
    if (!silent) setLoading(true);
    try {
      setDashboard(await loadAdminAnalytics(sessionToken));
      setAuthenticated(true); setError('');
    } catch (requestError) {
      if (!silent) setError(requestError.message);
      if (/identifiants/i.test(requestError.message)) {
        setAuthenticated(false);
        setSessionToken('');
        try { window.sessionStorage.removeItem(ADMIN_SESSION_KEY); } catch { /* storage unavailable */ }
      }
    } finally { if (!silent) setLoading(false); }
  }, [sessionToken]);

  const signIn = async () => {
    if (!credentials.username || !credentials.password) return;
    setLoading(true); setError('');
    try {
      const session = await createAdminSession(credentials.username, credentials.password);
      window.sessionStorage.setItem(ADMIN_SESSION_KEY, session.token);
      setSessionToken(session.token);
      setDashboard(await loadAdminAnalytics(session.token));
      setCredentials((current) => ({ ...current, password: '' }));
      setAuthenticated(true);
    } catch (requestError) {
      setError(requestError.message);
      setAuthenticated(false);
    } finally { setLoading(false); }
  };

  const signOut = () => {
    try { window.sessionStorage.removeItem(ADMIN_SESSION_KEY); } catch { /* storage unavailable */ }
    setSessionToken(''); setAuthenticated(false); setDashboard(null);
    setCredentials((current) => ({ ...current, password: '' }));
  };

  useEffect(() => {
    if (!authenticated) return undefined;
    refresh(true);
    const updateWhenVisible = () => { if (document.visibilityState === 'visible') refresh(true); };
    const timer = window.setInterval(updateWhenVisible, 15_000);
    document.addEventListener('visibilitychange', updateWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', updateWhenVisible);
    };
  }, [authenticated, refresh]);

  useEffect(() => {
    try { window.localStorage.setItem(ADMIN_VIEW_KEY, JSON.stringify({ username: credentials.username, activeTab, catalogueTab })); } catch { /* storage unavailable */ }
  }, [activeTab, catalogueTab, credentials.username]);

  useEffect(() => {
    fetch(`${EDGE_API_URL}/api/site-settings`).then((response) => response.json()).then((value) => setSettings({ destinationUrl: value.destinationUrl || '', buttonLabel: value.buttonLabel || 'Accéder au site' })).catch(() => null);
  }, []);

  const saveSettings = async (event) => {
    event.preventDefault(); setSaving(true); setSaved(false);
    try {
      const response = await fetch(`${EDGE_API_URL}/api/site-settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` }, body: JSON.stringify(settings) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Enregistrement impossible');
      setSettings({ destinationUrl: result.destinationUrl, buttonLabel: result.buttonLabel }); setSaved(true);
    } catch (requestError) { setError(requestError.message); }
    finally { setSaving(false); }
  };

  const totals = dashboard?.totals || initialTotals;
  const filteredUsers = useMemo(() => (dashboard?.users || []).filter((user) => `${user.displayName} ${user.email}`.toLowerCase().includes(query.toLowerCase())), [dashboard, query]);
  const catalogueItems = useMemo(() => (dashboard?.catalogue?.[catalogueTab] || []).filter((item) => `${item.title || ''} ${item.lookupPath || ''} ${item.mediaId || ''}`.toLowerCase().includes(query.toLowerCase())), [catalogueTab, dashboard, query]);
  const maxTrend = Math.max(1, ...(dashboard?.trends || []).map((point) => Math.max(point.pageViews, point.playbackStarts)));

  if (!authenticated) return <main className="flex min-h-screen items-center justify-center bg-[#05070c] px-4 text-white"><section className="w-full max-w-md rounded-3xl border border-white/10 bg-[#0d111b] p-8 shadow-2xl"><Link to="/" className="mb-8 flex w-fit items-center gap-3 text-xl font-black"><span className="flex h-11 w-11 items-center justify-center rounded-xl bg-red-600"><FaPlay className="text-sm" /></span>We<span className="-ml-3 text-red-500">Flix</span> <small className="text-gray-500">Admin</small></Link><span className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/10 text-red-400"><FaLock /></span><h1 className="text-2xl font-black">Connexion administrateur</h1><p className="mt-2 text-sm text-gray-500">Accès réservé aux responsables de la plateforme.</p><form className="mt-7 space-y-4" onSubmit={(event) => { event.preventDefault(); signIn(); }}><label className="block"><span className="mb-2 block text-xs font-bold text-gray-400">Nom d’utilisateur</span><input required autoComplete="username" value={credentials.username} onChange={(event) => setCredentials((current) => ({ ...current, username: event.target.value }))} className="admin-input" /></label><label className="block"><span className="mb-2 block text-xs font-bold text-gray-400">Mot de passe</span><input required type="password" autoComplete="current-password" value={credentials.password} onChange={(event) => setCredentials((current) => ({ ...current, password: event.target.value }))} className="admin-input" /></label>{error && <p className="text-sm text-red-400">{error}</p>}<button disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-xl bg-red-600 px-5 py-3.5 font-black hover:bg-red-500 disabled:opacity-50">{loading ? <FaSpinner className="animate-spin" /> : <FaLock />} Se connecter</button></form></section></main>;

  return <main className="min-h-screen bg-[#05070c] text-white">
    <header className="sticky top-0 z-40 border-b border-white/10 bg-[#080b12]/95 backdrop-blur-xl"><div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4 px-4 py-3 sm:px-6"><Link to="/" className="flex items-center gap-2 font-black"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-red-600"><FaPlay className="text-xs" /></span>We<span className="-ml-2 text-red-500">Flix</span><Badge>Administration</Badge></Link><div className="flex items-center gap-2"><span className="hidden text-xs text-gray-500 sm:block">Mis à jour {formatAgo(dashboard?.generatedAt)}</span><button onClick={() => refresh()} className="rounded-xl border border-white/10 p-2.5 text-gray-400 hover:text-white"><FaSyncAlt className={loading ? 'animate-spin' : ''} /></button><button onClick={signOut} className="rounded-xl border border-white/10 p-2.5 text-gray-400 hover:text-red-400" title="Déconnexion"><FaSignOutAlt /></button></div></div></header>
    <div className="mx-auto grid max-w-[1500px] gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[220px_1fr]">
      <aside className="h-fit rounded-2xl border border-white/10 bg-[#0d111b] p-2 lg:sticky lg:top-20">{tabs.map(([id, label, Icon]) => <button key={id} onClick={() => { setActiveTab(id); setQuery(''); }} className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm font-bold transition ${activeTab === id ? 'bg-red-600 text-white' : 'text-gray-400 hover:bg-white/5 hover:text-white'}`}><Icon />{label}</button>)}<div className="my-2 border-t border-white/10" /><Link to="/" className="flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-bold text-gray-500 hover:text-white"><FaArrowLeft />Retour au site</Link></aside>
      <div className="min-w-0">
        {activeTab === 'overview' && <Overview dashboard={dashboard} totals={totals} maxTrend={maxTrend} />}
        {activeTab === 'users' && <UsersView users={filteredUsers} query={query} setQuery={setQuery} />}
        {activeTab === 'catalogue' && <CatalogueView dashboard={dashboard} totals={totals} active={catalogueTab} setActive={setCatalogueTab} items={catalogueItems} query={query} setQuery={setQuery} />}
        {activeTab === 'activity' && <ActivityView dashboard={dashboard} />}
        {activeTab === 'system' && <SystemView dashboard={dashboard} settings={settings} setSettings={setSettings} onSave={saveSettings} saving={saving} saved={saved} />}
      </div>
    </div>
  </main>;
}

const Overview = ({ dashboard, totals, maxTrend }) => <div className="space-y-6"><Title eyebrow="Temps réel" title="Vue d’ensemble" description="Données mesurées par WeFlix, R2 et le lecteur public." /><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Card icon={FaUsers} label="En ligne" value={formatter.format(totals.online)} detail="Actifs depuis moins de 90 secondes" color="green" /><Card icon={FaPlay} label="En lecture" value={formatter.format(totals.watching)} detail="Sessions vidéo actives" /><Card icon={FaUser} label="Utilisateurs observés" value={formatter.format(totals.usersObserved)} detail="Profils remontés au Worker" color="blue" /><Card icon={FaEye} label="Lectures lancées" value={compact.format(totals.playbackStarts)} detail={`${formatter.format(totals.completions)} terminées`} color="purple" /><Card icon={FaClock} label="Temps regardé" value={formatDuration(totals.watchSeconds)} detail="Durée cumulée réelle" color="amber" /><Card icon={FaFilm} label="Films lisibles" value={formatter.format(totals.movies)} detail="Durée validée ≥ 20 min" /><Card icon={FaTv} label="Séries lisibles" value={formatter.format(totals.series)} detail={`${formatter.format(totals.episodes)} épisodes complets`} color="green" /><Card icon={FaTasks} label="En attente" value={formatter.format(totals.pending)} detail={`${formatter.format(totals.unavailable)} indisponibles`} color="amber" /></div><div className="grid gap-6 xl:grid-cols-[1.1fr_.9fr]"><Panel title="Activité sur 14 jours" subtitle="Pages consultées et lectures lancées"><div className="flex h-52 items-end gap-2">{(dashboard?.trends || []).length ? dashboard.trends.map((point) => <div key={point.date} className="flex min-w-0 flex-1 flex-col items-center gap-2"><div className="flex h-40 w-full items-end justify-center gap-1"><div title={`${point.pageViews} pages`} className="w-2/5 rounded-t bg-blue-500/70" style={{ height: `${Math.max(3, point.pageViews / maxTrend * 100)}%` }} /><div title={`${point.playbackStarts} lectures`} className="w-2/5 rounded-t bg-red-500" style={{ height: `${Math.max(3, point.playbackStarts / maxTrend * 100)}%` }} /></div><span className="text-[10px] text-gray-600">{point.date.slice(5)}</span></div>) : <Empty>Aucune tendance enregistrée pour le moment.</Empty>}</div></Panel><Panel title="État du catalogue" subtitle="Seuls les fichiers complets sont comptés"><div className="space-y-4"><Metric label="Films complets" value={totals.movies} color="bg-red-500" /><Metric label="Épisodes complets" value={totals.episodes} color="bg-emerald-500" /><Metric label="Manifestes incomplets exclus" value={totals.invalidManifests} color="bg-amber-500" /><Metric label="Contenus sans source" value={totals.unavailable} color="bg-gray-500" /></div></Panel></div><div className="grid gap-6 xl:grid-cols-2"><Watching items={dashboard?.watching || []} /><Online items={dashboard?.online || []} /></div></div>;

const UsersView = ({ users, query, setQuery }) => <div className="space-y-6"><Title eyebrow="Comptes" title="Utilisateurs" description="Profils et visiteurs ayant réellement communiqué avec WeFlix depuis l’activation de la télémétrie." /><Search value={query} onChange={setQuery} placeholder="Rechercher par nom ou e-mail…" /><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{users.length ? users.map((user) => <article key={user.userId} className="rounded-2xl border border-white/10 bg-[#0d111b] p-5"><div className="flex items-start gap-4">{user.photoUrl ? <img src={user.photoUrl} alt="" className="h-12 w-12 rounded-full object-cover" referrerPolicy="no-referrer" /> : <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/5 text-lg font-black">{(user.displayName || user.email || '?')[0].toUpperCase()}</span>}<div className="min-w-0 flex-1"><p className="truncate font-black">{user.displayName || 'Sans nom'}</p><p className="truncate text-xs text-gray-500">{user.email || (user.isGuest ? 'Navigation sans compte' : 'E-mail indisponible')}</p><div className="mt-2 flex flex-wrap gap-2">{user.isGuest ? <Badge>Visiteur</Badge> : <Badge color={user.emailVerified ? 'green' : 'amber'}>{user.emailVerified ? 'E-mail vérifié' : 'Non vérifié'}</Badge>}{(user.providers || []).map((provider) => <Badge key={provider} color="blue">{provider.replace('.com', '')}</Badge>)}</div></div></div><dl className="mt-5 grid grid-cols-3 gap-2 border-t border-white/10 pt-4 text-center"><UserMetric label="Lectures" value={user.playbackStarts} /><UserMetric label="Temps" value={formatDuration(user.watchSeconds)} /><UserMetric label="Pages" value={user.pageViews} /></dl><div className="mt-4 space-y-1 text-xs text-gray-500"><p>Première activité : {formatDate(user.firstSeenAt)}</p><p>Dernière activité : {formatDate(user.lastSeenAt)}</p><p>Lectures terminées : {formatter.format(user.completions || 0)}</p><p className="truncate">UID : {user.userId}</p></div></article>) : <Empty icon={FaUser}>Aucun utilisateur correspondant. Le total Firebase Auth complet nécessite encore l’API Firebase Admin serveur.</Empty>}</div></div>;

const CatalogueView = ({ dashboard, totals, active, setActive, items, query, setQuery }) => <div className="space-y-6"><Title eyebrow="R2" title="Catalogue réel" description="Contenus physiquement préparés, files et erreurs — sans compter les faux manifestes tests." /><div className="flex flex-wrap gap-2">{catalogueTabs.map(([id, label]) => <button key={id} onClick={() => setActive(id)} className={`rounded-xl px-4 py-2 text-sm font-bold ${active === id ? 'bg-red-600' : 'bg-white/5 text-gray-400 hover:bg-white/10'}`}>{label} <span className="ml-1 opacity-60">{active === 'movies' && id === active ? totals.movies : active === 'series' && id === active ? totals.series : active === 'episodes' && id === active ? totals.episodes : active === 'pending' && id === active ? totals.pending : active === 'unavailable' && id === active ? totals.unavailable : active === 'invalid' && id === active ? totals.invalidManifests : ''}</span></button>)}</div><Search value={query} onChange={setQuery} placeholder="Rechercher dans cette liste…" /><Panel title={`${items.length} élément${items.length > 1 ? 's' : ''}`} subtitle={`Objets catalogue analysés : ${formatter.format(dashboard?.system?.catalogueObjects || 0)}`}><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="text-xs uppercase text-gray-600"><tr><th className="pb-3">Titre</th><th className="pb-3">Identifiant</th><th className="pb-3">État</th><th className="pb-3">Durée/épisodes</th><th className="pb-3">Mise à jour</th></tr></thead><tbody className="divide-y divide-white/5">{items.map((item, index) => <tr key={item.lookupPath || `${item.mediaType}-${item.mediaId}-${index}`}><td className="py-3 pr-4 font-bold">{item.title || 'Titre inconnu'}</td><td className="py-3 pr-4 text-xs text-gray-500">{item.lookupPath || `${item.mediaType || ''}/${item.mediaId || ''}`}</td><td className="py-3 pr-4"><Badge color={active === 'unavailable' || active === 'invalid' ? 'red' : active === 'pending' ? 'amber' : 'green'}>{active === 'unavailable' ? item.reason || 'Indisponible' : active === 'invalid' ? 'Incomplet' : active === 'pending' ? item.status || 'En attente' : 'Lisible'}</Badge></td><td className="py-3 pr-4 text-gray-400">{item.episodes ? `${item.episodes} épisodes` : item.duration ? formatDuration(item.duration) : '—'}</td><td className="py-3 text-xs text-gray-500">{formatDate(item.updatedAt || item.lastUpdatedAt || item.checkedAt || item.createdAt)}</td></tr>)}</tbody></table>{!items.length && <Empty>Aucune donnée dans cette catégorie.</Empty>}</div></Panel></div>;

const ActivityView = ({ dashboard }) => <div className="space-y-6"><Title eyebrow="Historique" title="Activité récente" description="Navigation et événements de lecture enregistrés par le Worker." /><Panel title={`${dashboard?.recentActivity?.length || 0} derniers événements`}><div className="space-y-2">{(dashboard?.recentActivity || []).map((item, index) => <div key={`${item.createdAt}-${index}`} className="flex items-start gap-3 rounded-xl bg-white/[.025] p-4"><span className={`mt-1 h-2.5 w-2.5 rounded-full ${item.type === 'playback_start' ? 'bg-red-500' : item.type === 'playback_complete' ? 'bg-emerald-500' : 'bg-blue-500'}`} /><div className="min-w-0 flex-1"><p className="truncate text-sm"><b>{item.displayName || item.email || 'Utilisateur'}</b> {eventText[item.type] || item.type}</p><p className="mt-1 truncate text-xs text-gray-500">{item.title || item.path || 'WeFlix'}</p></div><time className="shrink-0 text-xs text-gray-600">{formatAgo(item.createdAt)}</time></div>)}{!dashboard?.recentActivity?.length && <Empty icon={FaHistory}>Aucun événement enregistré.</Empty>}</div></Panel></div>;

const OriginMetrics = ({ origin }) => {
  if (!origin) return <Panel title="Origine de streaming" subtitle="Connexion directe"><Empty icon={FaServer}>L’origine locale/VPS n’est pas encore joignable depuis le Worker.</Empty></Panel>;
  const lanes = origin.r2?.lanes || {};
  const pending = Number(origin.r2?.pending ?? Object.values(origin.queues || {}).reduce((sum, value) => sum + Number(value || 0), 0));
  return <Panel title="Performance de mise à disposition" subtitle={`Mesures de l’origine · ${formatDate(origin.generatedAt)}`}><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5"><Card icon={FaPlay} label="Première image médiane" value={formatLatency(origin.timings?.firstFrame?.median)} detail={`p95 : ${formatLatency(origin.timings?.firstFrame?.p95)}`} color="green" /><Card icon={FaDatabase} label="Remux fMP4 médian" value={formatLatency(origin.timings?.remuxFmp4?.median)} detail={`${origin.r2?.layout || 'legacy-ts'} · ${formatter.format(lanes.activeLight || 0)}/${formatter.format(2)} actif`} color="blue" /><Card icon={FaClock} label="Transcodage médian" value={formatLatency(origin.timings?.transcodeFmp4?.median || origin.timings?.r2?.median)} detail={`${formatter.format(lanes.activeHeavy || 0)}/1 actif · ${origin.r2?.paused ? `pause ${origin.r2.pauseReason}` : 'en cours'}`} color="purple" /><Card icon={FaTasks} label="Publications en attente" value={formatter.format(pending)} detail={`${formatter.format(origin.r2?.repairsPruned || 0)} réparation(s) retirée(s) · ${formatter.format(origin.live?.active || 0)} direct`} color="amber" /><Card icon={FaServer} label="Contenus multi-source" value={formatter.format(origin.multiSource?.media || 0)} detail={`${formatter.format(origin.multiSource?.candidates || 0)} source(s) validée(s) · ${formatter.format(origin.multiSource?.failed || 0)} en échec`} color="green" /></div></Panel>;
};

const SystemView = ({ dashboard, settings, setSettings, onSave, saving, saved }) => <div className="space-y-6"><Title eyebrow="Infrastructure" title="Système et réglages" description="État des services visibles depuis le Worker et configuration publique." /><div className="grid gap-4 sm:grid-cols-3"><Card icon={FaServer} label="Worker Cloudflare" value="En ligne" detail={formatDate(dashboard?.system?.generatedAt)} color="green" /><Card icon={FaDatabase} label="Stockage R2" value="En ligne" detail={`${formatter.format(dashboard?.system?.catalogueObjects || 0)} manifestes analysés`} color="green" /><Card icon={FaExclamationTriangle} label="Manifestes exclus" value={formatter.format(dashboard?.totals?.invalidManifests || 0)} detail="Fichiers incomplets ou tests" color="amber" /></div><OriginMetrics origin={dashboard?.system?.origin} /><Panel title="Configuration du portail" subtitle="Destination du bouton de la page d’accès"><form onSubmit={onSave} className="grid gap-4 lg:grid-cols-[1fr_.5fr_auto] lg:items-end"><label><span className="mb-2 block text-xs font-bold text-gray-400">URL de destination</span><input type="url" required value={settings.destinationUrl} onChange={(event) => setSettings((current) => ({ ...current, destinationUrl: event.target.value }))} className="admin-input" /></label><label><span className="mb-2 block text-xs font-bold text-gray-400">Libellé du bouton</span><input required value={settings.buttonLabel} onChange={(event) => setSettings((current) => ({ ...current, buttonLabel: event.target.value }))} className="admin-input" /></label><button disabled={saving} className="flex items-center justify-center gap-2 rounded-xl bg-red-600 px-5 py-3 font-black"><FaSave />{saving ? 'Enregistrement…' : 'Enregistrer'}</button></form>{saved && <p className="mt-4 flex items-center gap-2 text-sm text-emerald-400"><FaCheckCircle />Configuration enregistrée.</p>}</Panel><Panel title="Sources des données"><ul className="space-y-3 text-sm text-gray-400"><li><b className="text-white">Utilisateurs :</b> profils authentifiés ayant envoyé une présence ou une lecture.</li><li><b className="text-white">Catalogue :</b> manifestes R2 ouverts et validés par leur durée réelle.</li><li><b className="text-white">Direct :</b> pulsations de moins de 90 secondes.</li><li><b className="text-white">Limite actuelle :</b> les comptes Firebase Auth n’ayant jamais visité cette version du site n’apparaissent pas encore.</li></ul></Panel></div>;

const Watching = ({ items }) => <Panel title="Visionnages en direct" subtitle="Progression actuelle" action={<Badge color="green">● DIRECT</Badge>}>{items.length ? <div className="space-y-3">{items.map((item) => <div key={item.userId} className="rounded-xl bg-white/[.025] p-4"><div className="flex justify-between gap-3"><div className="min-w-0"><p className="truncate font-bold">{item.title}</p><p className="truncate text-xs text-gray-500">{item.displayName || item.email}</p></div><b className="text-red-400">{item.progress || 0} %</b></div><div className="mt-3 h-1.5 rounded-full bg-white/10"><div className="h-full rounded-full bg-red-500" style={{ width: `${Math.max(1, item.progress || 0)}%` }} /></div></div>)}</div> : <Empty icon={FaPauseCircle}>Aucune lecture active.</Empty>}</Panel>;
const Online = ({ items }) => <Panel title="Profils en ligne" subtitle="Comptes connectés et visiteurs récents">{items.length ? <div className="space-y-2">{items.map((item) => <div key={item.userId} className="flex items-center gap-3 rounded-xl bg-white/[.025] p-3"><span className="relative flex h-10 w-10 items-center justify-center rounded-full bg-white/5 font-black">{(item.displayName || item.email || '?')[0].toUpperCase()}<i className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-[#0d111b] bg-emerald-400" /></span><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="truncate text-sm font-bold">{item.displayName || item.email}</p>{item.isGuest && <Badge>Visiteur</Badge>}</div><p className="truncate text-xs text-gray-500">{item.path || '/'} · {formatAgo(item.lastSeenAt)}</p></div></div>)}</div> : <Empty icon={FaUsers}>Aucun profil actif.</Empty>}</Panel>;
const Title = ({ eyebrow, title, description }) => <div><p className="text-xs font-black uppercase tracking-[.22em] text-red-400">{eyebrow}</p><h1 className="mt-2 text-3xl font-black">{title}</h1><p className="mt-2 text-sm text-gray-500">{description}</p></div>;
const Search = ({ value, onChange, placeholder }) => <label className="relative block"><FaSearch className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-600" /><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="w-full rounded-xl border border-white/10 bg-[#0d111b] py-3 pl-11 pr-4 outline-none focus:border-red-500/50" /></label>;
const Metric = ({ label, value, color }) => <div><div className="mb-2 flex justify-between text-sm"><span className="text-gray-400">{label}</span><b>{formatter.format(value || 0)}</b></div><div className="h-1.5 rounded-full bg-white/5"><div className={`h-full max-w-full rounded-full ${color}`} style={{ width: `${Math.min(100, Math.max(2, Number(value || 0)))}%` }} /></div></div>;
const UserMetric = ({ label, value }) => <div><dt className="text-[10px] uppercase text-gray-600">{label}</dt><dd className="mt-1 text-xs font-black">{typeof value === 'number' ? formatter.format(value || 0) : value}</dd></div>;

Card.propTypes = { icon: PropTypes.elementType.isRequired, label: PropTypes.string.isRequired, value: PropTypes.node.isRequired, detail: PropTypes.string.isRequired, color: PropTypes.string };
Panel.propTypes = { title: PropTypes.string.isRequired, subtitle: PropTypes.string, action: PropTypes.node, children: PropTypes.node.isRequired, className: PropTypes.string };
Empty.propTypes = { icon: PropTypes.elementType, children: PropTypes.node.isRequired }; Badge.propTypes = { color: PropTypes.string, children: PropTypes.node.isRequired };
Overview.propTypes = { dashboard: PropTypes.object, totals: PropTypes.object.isRequired, maxTrend: PropTypes.number.isRequired }; UsersView.propTypes = { users: PropTypes.array.isRequired, query: PropTypes.string.isRequired, setQuery: PropTypes.func.isRequired };
CatalogueView.propTypes = { dashboard: PropTypes.object, totals: PropTypes.object.isRequired, active: PropTypes.string.isRequired, setActive: PropTypes.func.isRequired, items: PropTypes.array.isRequired, query: PropTypes.string.isRequired, setQuery: PropTypes.func.isRequired };
ActivityView.propTypes = { dashboard: PropTypes.object }; SystemView.propTypes = { dashboard: PropTypes.object, settings: PropTypes.object.isRequired, setSettings: PropTypes.func.isRequired, onSave: PropTypes.func.isRequired, saving: PropTypes.bool.isRequired, saved: PropTypes.bool.isRequired };
OriginMetrics.propTypes = { origin: PropTypes.object };
Watching.propTypes = { items: PropTypes.array.isRequired }; Online.propTypes = { items: PropTypes.array.isRequired }; Title.propTypes = { eyebrow: PropTypes.string.isRequired, title: PropTypes.string.isRequired, description: PropTypes.string.isRequired };
Search.propTypes = { value: PropTypes.string.isRequired, onChange: PropTypes.func.isRequired, placeholder: PropTypes.string.isRequired }; Metric.propTypes = { label: PropTypes.string.isRequired, value: PropTypes.number, color: PropTypes.string.isRequired }; UserMetric.propTypes = { label: PropTypes.string.isRequired, value: PropTypes.oneOfType([PropTypes.number, PropTypes.string]) };
