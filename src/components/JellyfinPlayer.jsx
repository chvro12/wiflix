import { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { FaCog, FaExpand, FaPause, FaPlay, FaSpinner, FaVolumeMute, FaVolumeUp } from 'react-icons/fa';
import Hls from 'hls.js';
import { auth } from '../firebase';
import { sendAnalyticsEvent } from '../utils/analytics';
import { getSavedPlaybackPosition, savePlaybackPosition } from '../utils/continueWatching';

const EDGE_API_URL = String(import.meta.env.VITE_EDGE_API_URL || '').replace(/\/$/, '');
const LOCAL_FRONTEND = typeof window !== 'undefined' && ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
const WAITING_MESSAGES = [
  'On prépare votre séance…',
  'Le popcorn sera sûrement prêt avant nous.',
  'On choisit la plus belle version disponible.',
  'Quelques secondes, le générique approche…',
  'Les derniers préparatifs sont en cours…',
  'Installez-vous confortablement, on s’occupe du reste.',
  'Silence sur le plateau… votre séance se prépare.',
  'On déroule le tapis rouge jusqu’au lecteur.',
  'Votre canapé peut commencer à réserver votre place.',
  'On vérifie que chaque pixel est à sa place.',
  'Le projectionniste virtuel fait ses derniers réglages.',
  'Encore un petit instant avant que les lumières s’éteignent.',
  'On rembobine jusqu’au tout début, promis.',
  'La bobine arrive, sans les publicités.',
  'Préparation du grand écran en cours…',
  'On cherche la version qui mérite votre écran.',
  'Le film enfile son plus beau costume.',
  'Votre séance passe bientôt en mode plein écran.',
  'On branche le son, l’image et un peu de magie.',
  'Les pixels font la queue dans le bon ordre.',
  'Le générique chauffe déjà dans les coulisses.',
  'On négocie une arrivée express avec le film.',
  'La salle est presque prête, gardez votre place.',
  'Un dernier contrôle qualité avant le clap de départ.',
  'Ça charge… mais avec beaucoup de conviction.',
  'Le cinéma à domicile prend quelques secondes pour s’habiller.',
  'Ne touchez pas à la télécommande, tout se passe bien.',
  'On prépare une entrée digne d’un premier rôle.',
  'Votre film traverse les coulisses à toute vitesse.',
  'Bientôt à l’écran : exactement ce que vous avez choisi.',
  'On aligne les images avant de lancer la séance.',
  'La magie du cinéma est en cours de livraison.',
  'Patience… même les héros ont besoin d’une entrée.',
  'On baisse bientôt les lumières.',
  'Dernier arrêt technique avant votre séance.',
];

const nextWaitingMessage = (current = -1) => {
  if (WAITING_MESSAGES.length < 2) return 0;
  if (current < 0) return Math.floor(Math.random() * WAITING_MESSAGES.length);
  const candidate = Math.floor(Math.random() * (WAITING_MESSAGES.length - 1));
  return candidate >= current ? candidate + 1 : candidate;
};

const normalizeProvisionMessage = (message) => {
  const value = String(message || '').trim();
  if (!value) return '';
  if (/connectez-vous|connexion requise|unauthorized|non autoris/i.test(value)) {
    return 'Connectez-vous pour regarder ce contenu.';
  }
  if (/aucune véritable source|aucune source|aucun fichier|ne correspondent pas exactement|not found|introuvable/i.test(value)) {
    return 'Ce contenu n’est pas disponible pour le moment. Nous réessaierons automatiquement.';
  }
  if (/timeout|délai|timed out|plus de temps que prévu/i.test(value)) {
    return 'La préparation prend plus de temps que prévu. Réessayez dans quelques minutes.';
  }
  if (/impossible de lancer|ne peut pas être lue|ne peut pas reprendre|momentanément indisponible/i.test(value)) {
    return 'Impossible de lancer la vidéo pour le moment. Réessayez dans un instant.';
  }
  if (/failed|échec|erreur|manifest|segment|hls|r2|jellyfin|transcod|remux|codec|ffmpeg|source vidéo|flux/i.test(value)) {
    return 'La vidéo a rencontré un problème. Réessayez dans un instant.';
  }
  return 'Votre vidéo est en cours de préparation.';
};

const isUnavailableProvision = (provision) => provision?.status === 'retrying' || provision?.availabilityState === 'live_failed';

const formatEta = (seconds) => {
  const value = Math.max(0, Math.ceil(Number(seconds) || 0));
  if (value < 60) return `${value} s`;
  return `${Math.floor(value / 60)} min ${String(value % 60).padStart(2, '0')} s`;
};

const waitingStatusText = (status) => {
  if (status.phase === 'queued') return status.queuePosition > 1
    ? `Votre vidéo est dans la file d’attente (position ${status.queuePosition}).`
    : 'Votre vidéo va bientôt être préparée.';
  if (status.phase === 'probing') return 'Vidéo trouvée, nous préparons la meilleure version…';
  if (status.phase === 'buffering') return 'Presque prête, encore quelques instants…';
  if (status.message) return normalizeProvisionMessage(status.message);
  return WAITING_MESSAGES[status.messageIndex];
};

const JellyfinPlayer = ({ lookupPath, title, unavailableText }) => {
  const [state, setState] = useState({ loading: true, media: null, error: null });
  const [requestState, setRequestState] = useState({ pending: false, unavailable: false, progress: 0, progressMode: 'indeterminate', phase: '', queuePosition: 0, bufferedSeconds: 0, targetBufferSeconds: 0, heartbeatAt: null, messageIndex: 0, message: '', etaSeconds: null, etaKind: null, error: null });
  const [offset, setOffset] = useState(0);
  const [, setPosition] = useState(0);
  const [sliderPosition, setSliderPosition] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isBuffering, setIsBuffering] = useState(true);
  const [selectedAudio, setSelectedAudio] = useState('');
  const [selectedSubtitle, setSelectedSubtitle] = useState('off');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sourceSwitching, setSourceSwitching] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [retryNonce, setRetryNonce] = useState(0);
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const playerRef = useRef(null);
  const controlsTimerRef = useRef(null);
  const settingsRef = useRef(null);
  const resumeAfterSeek = useRef(false);
  const isScrubbingRef = useRef(false);
  const seekTargetRef = useRef(0);
  const autoplayPending = useRef(true);
  const analyticsStartedRef = useRef(false);
  const analyticsLastPositionRef = useRef(0);
  const analyticsLastSentAtRef = useRef(0);
  const seekRequestRef = useRef(0);
  const seekTimerRef = useRef(null);
  const seekPendingTargetRef = useRef(null);
  const resumePositionRef = useRef(0);
  const resumeAppliedRef = useRef(false);
  const progressLastSavedAtRef = useRef(0);
  const sourceSwitchRef = useRef(false);
  const seerrUrl = import.meta.env.VITE_SEERR_URL || 'http://localhost:5055';

  const reportPlayback = (type, video = videoRef.current) => {
    if (!state.media?.available) return;
    const base = state.media?.provider === 'origin' ? Number(state.media.startOffset || 0) : state.media?.provider === 'r2' ? 0 : offset;
    const position = Math.max(0, base + Number(video?.currentTime || 0));
    const secondsViewed = Math.max(0, Math.min(60, position - analyticsLastPositionRef.current));
    analyticsLastPositionRef.current = position;
    analyticsLastSentAtRef.current = Date.now();
    sendAnalyticsEvent(type, {
      lookupPath,
      title: title || state.media.name || lookupPath,
      mediaType: lookupPath.startsWith('movie/') ? 'movie' : 'episode',
      position: Math.round(position),
      duration: Math.round(Number(state.media.duration || 0)),
      secondsViewed: type === 'playback_heartbeat' ? Math.round(secondsViewed) : 0,
      provider: state.media.provider || 'jellyfin',
      isPlaying: ['playback_start', 'playback_heartbeat'].includes(type),
    });
  };

  useEffect(() => {
    const controller = new AbortController();
    let pollTimer;
    let progressTimer;
    let pollAttempts = 0;
    const savedPosition = getSavedPlaybackPosition(lookupPath);
    resumePositionRef.current = savedPosition;
    resumeAppliedRef.current = false;
    progressLastSavedAtRef.current = 0;
    setOffset(0);
    setPosition(savedPosition);
    setSliderPosition(savedPosition);
    seekTargetRef.current = savedPosition;
    seekRequestRef.current += 1;
    isScrubbingRef.current = false;
    setSelectedAudio('');
    setSelectedSubtitle('off');
    setSettingsOpen(false);
    setIsMuted(false);
    autoplayPending.current = true;
    analyticsStartedRef.current = false;
    analyticsLastPositionRef.current = 0;
    analyticsLastSentAtRef.current = 0;
    setState({ loading: true, media: null, error: null });
    setRequestState({ pending: false, unavailable: false, progress: 0, progressMode: 'indeterminate', phase: '', queuePosition: 0, bufferedSeconds: 0, targetBufferSeconds: 0, heartbeatAt: null, messageIndex: 0, message: '', etaSeconds: null, etaKind: null, error: null });
    const loadMedia = async () => {
      if (EDGE_API_URL) {
        await auth.authStateReady();
        const headers = {};
        if (auth.currentUser) headers.Authorization = `Bearer ${await auth.currentUser.getIdToken()}`;
        const edgeResponse = await fetch(`${EDGE_API_URL}/api/media/lookup/${lookupPath}`, { headers, signal: controller.signal });
        const edgePayload = await edgeResponse.json().catch(() => ({}));
        if (edgeResponse.ok) return edgePayload;
        if (!LOCAL_FRONTEND) {
          // A 404 can mean that the source exists but its first HLS segments
          // are still being generated. Preserve this state so anonymous
          // viewers keep polling instead of seeing "indisponible" or being
          // asked to create a duplicate Seerr request.
          if ([404, 503].includes(edgeResponse.status)) return { ...edgePayload, available: false };
          throw new Error('Impossible de lancer la vidéo pour le moment.');
        }
      }
      const jellyfinResponse = await fetch(`/api/jellyfin/${lookupPath}`, { signal: controller.signal });
      if (!jellyfinResponse.ok) throw new Error('Impossible de lancer la vidéo pour le moment.');
      return jellyfinResponse.json();
    };

    const requestMissingMedia = async () => {
      const [mediaType, mediaId, season, episode] = lookupPath.split('/');
      const headers = { 'Content-Type': 'application/json' };
      if (EDGE_API_URL) {
        await auth.authStateReady();
        if (!auth.currentUser) throw new Error('Connectez-vous pour regarder ce contenu.');
        headers.Authorization = `Bearer ${await auth.currentUser.getIdToken()}`;
      }
      const payload = JSON.stringify({ mediaType: mediaType === 'episode' ? 'tv' : 'movie', mediaId: Number(mediaId), season: Number(season) || undefined, episode: Number(episode) || undefined });
      const endpoints = EDGE_API_URL ? [`${EDGE_API_URL}/api/media/request`, '/api/media/request'] : ['/api/media/request'];
      let lastError = 'Impossible de lancer la demande automatique.';
      for (const endpoint of endpoints) {
        const response = await fetch(endpoint, { method: 'POST', headers, signal: controller.signal, body: payload });
        const result = await response.json().catch(() => ({}));
        if (response.ok) return result;
        lastError = response.status === 401
          ? 'Connectez-vous pour regarder ce contenu.'
          : 'La séance n’a pas pu être préparée pour le moment. Une nouvelle tentative sera faite automatiquement.';
        if (![404, 502, 503].includes(response.status)) break;
      }
      throw new Error(lastError);
    };

    const loadProvisionStatus = async () => {
      const endpoints = [];
      if (EDGE_API_URL) {
        await auth.authStateReady();
        if (auth.currentUser) endpoints.push({
          url: `${EDGE_API_URL}/api/media/status/${lookupPath}`,
          headers: { Authorization: `Bearer ${await auth.currentUser.getIdToken()}` },
        });
      }
      endpoints.push({ url: `/api/media/status/${lookupPath}`, headers: {} });
      for (const endpoint of endpoints) {
        const response = await fetch(endpoint.url, { headers: endpoint.headers, signal: controller.signal });
        if (!response.ok) continue;
        const status = await response.json();
        const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(status.updatedAt || new Date().toISOString())) / 1000));
        const etaIsAvailable = ['calculated', 'estimated'].includes(status.etaKind);
        const etaSeconds = etaIsAvailable && status.etaSeconds !== null && status.etaSeconds !== undefined && Number.isFinite(Number(status.etaSeconds))
          ? Math.max(0, Number(status.etaSeconds) - elapsed) : null;
        setRequestState((current) => ({
          ...current,
          pending: !isUnavailableProvision(status),
          unavailable: isUnavailableProvision(status),
          progress: Math.max(current.progress, Number(status.progress) || 0),
          progressMode: status.progressMode || current.progressMode,
          phase: status.phase || status.state || current.phase,
          queuePosition: Number(status.queuePosition) || 0,
          bufferedSeconds: Number(status.bufferedSeconds) || current.bufferedSeconds,
          targetBufferSeconds: Number(status.targetBufferSeconds) || current.targetBufferSeconds,
          heartbeatAt: status.heartbeatAt || status.updatedAt || current.heartbeatAt,
          message: normalizeProvisionMessage(status.message) || current.message,
          etaSeconds,
          etaKind: etaIsAvailable ? status.etaKind : null,
          error: status.error || null,
        }));
        return status;
      }
      return null;
    };

    const beginWaiting = (provision) => {
      setRequestState({
        pending: !isUnavailableProvision(provision),
        unavailable: isUnavailableProvision(provision),
        progress: Number(provision?.progress) || 5,
        progressMode: provision?.progressMode || 'indeterminate',
        phase: provision?.phase || provision?.state || provision?.status || '',
        queuePosition: Number(provision?.queuePosition) || 0,
        bufferedSeconds: Number(provision?.bufferedSeconds) || 0,
        targetBufferSeconds: Number(provision?.targetBufferSeconds) || 0,
        heartbeatAt: provision?.heartbeatAt || provision?.updatedAt || new Date().toISOString(),
        messageIndex: nextWaitingMessage(),
        message: normalizeProvisionMessage(provision?.message),
        etaSeconds: ['calculated', 'estimated'].includes(provision?.etaKind) && provision?.etaSeconds !== null && provision?.etaSeconds !== undefined && Number.isFinite(Number(provision.etaSeconds)) ? Number(provision.etaSeconds) : null,
        etaKind: ['calculated', 'estimated'].includes(provision?.etaKind) ? provision.etaKind : null,
        error: null,
      });
      let lastMessageChange = Date.now();
      progressTimer = setInterval(() => {
        setRequestState((current) => {
          const shouldRotateMessage = Date.now() - lastMessageChange >= 9000;
          if (shouldRotateMessage) lastMessageChange = Date.now();
          return {
            ...current,
            etaSeconds: ['calculated', 'estimated'].includes(current.etaKind) && Number.isFinite(current.etaSeconds) ? Math.max(0, current.etaSeconds - 1) : null,
            messageIndex: shouldRotateMessage ? nextWaitingMessage(current.messageIndex) : current.messageIndex,
          };
        });
      }, 1000);
    };

    const schedulePoll = () => {
      pollAttempts += 1;
      if (pollAttempts >= 114) {
        clearInterval(progressTimer);
        setRequestState((current) => ({
          ...current,
          pending: false,
          unavailable: true,
          etaSeconds: null,
          etaKind: null,
          message: 'La préparation prend plus de temps que prévu. Vous pouvez réessayer maintenant ou revenir dans quelques minutes.',
          error: 'Délai de préparation dépassé.',
        }));
        pollTimer = setTimeout(() => setRetryNonce((value) => value + 1), 60_000);
        return;
      }
      // Most cached AllDebrid releases become ready quickly. Poll aggressively
      // for the first minute, then back off to protect Jellyfin and R2.
      const delay = pollAttempts <= 30 ? 2000 : pollAttempts <= 90 ? 5000 : 10000;
      pollTimer = setTimeout(() => poll(false), delay);
    };

    const poll = async (firstAttempt = false) => {
      try {
        if (!firstAttempt) await loadProvisionStatus().catch(() => null);
        const media = await loadMedia();
        if (media?.available) {
          clearInterval(progressTimer);
          setRequestState((current) => ({ ...current, pending: false, unavailable: false, progress: 100, error: null }));
          setState({ loading: false, media, error: null });
          return;
        }
        if (media?.failed || media?.state === 'failed') {
          clearInterval(progressTimer);
          setRequestState((current) => ({
            ...current,
            pending: false,
            unavailable: true,
            progress: 0,
            etaSeconds: Number(media.retryAfterSeconds) || null,
            etaKind: null,
            message: normalizeProvisionMessage(media.error) || 'La vidéo a rencontré un problème. Vous pouvez réessayer dans un instant.',
            error: 'La vidéo n’a pas pu être préparée.',
          }));
          setState({ loading: false, media: null, error: normalizeProvisionMessage(media.error) || 'La vidéo a rencontré un problème.' });
          const retryDelay = Math.max(15, Number(media.retryAfterSeconds) || 60) * 1000;
          pollTimer = setTimeout(() => setRetryNonce((value) => value + 1), retryDelay);
          return;
        }
        if (media?.preparing || media?.rebuilding || ['queued', 'preparing'].includes(media?.state)) {
          if (firstAttempt) beginWaiting(media);
          else setRequestState((current) => ({
            ...current,
            pending: true,
            unavailable: false,
            progress: Number(media.progress) || current.progress,
            progressMode: media.progressMode || current.progressMode,
            phase: media.phase || media.state || current.phase,
            queuePosition: Number(media.queuePosition) || 0,
            bufferedSeconds: Number(media.bufferedSeconds) || 0,
            targetBufferSeconds: Number(media.targetBufferSeconds) || current.targetBufferSeconds,
            heartbeatAt: media.heartbeatAt || current.heartbeatAt,
            message: normalizeProvisionMessage(media.message) || current.message,
            etaSeconds: Number.isFinite(Number(media.etaSeconds)) ? Number(media.etaSeconds) : null,
            etaKind: media.etaKind || null,
          }));
          setState({ loading: false, media: { ...media, available: false }, error: null });
          schedulePoll();
          return;
        }
        if (firstAttempt) {
          const result = await requestMissingMedia();
          beginWaiting(result.provision);
        }
        setState({ loading: false, media: { ...(media || {}), available: false }, error: null });
        schedulePoll();
      } catch (error) {
        if (error.name === 'AbortError') return;
        if (firstAttempt) {
          try {
            const result = await requestMissingMedia();
            beginWaiting(result.provision);
            setState({ loading: false, media: { available: false }, error: null });
            schedulePoll();
          } catch (requestError) {
            if (requestError.name !== 'AbortError') {
              setState({ loading: false, media: null, error: requestError.message });
              setRequestState((current) => ({ ...current, pending: false, unavailable: true, error: requestError.message }));
            }
          }
          return;
        }
        // Jellyfin/R2 can be briefly unreachable while an import or a library
        // scan is in progress. Keep the waiting screen and retry quietly.
        schedulePoll();
      }
    };

    poll(true);
    return () => {
      seekRequestRef.current += 1;
      clearTimeout(seekTimerRef.current);
      controller.abort();
      clearTimeout(pollTimer);
      clearInterval(progressTimer);
    };
  }, [lookupPath, retryNonce, title]);

  const persistPlaybackPosition = (video = videoRef.current, force = false) => {
    if (!video || !auth.currentUser || !state.media?.available) return;
    const now = Date.now();
    if (!force && now - progressLastSavedAtRef.current < 10_000) return;
    const base = state.media?.provider === 'origin'
      ? Number(state.media.startOffset || 0)
      : state.media?.provider === 'r2' ? 0 : offset;
    const current = Math.max(0, base + Number(video.currentTime || 0));
    if (current < 3 && !video.ended) return;
    progressLastSavedAtRef.current = now;
    savePlaybackPosition(auth.currentUser.uid, lookupPath, current, Number(state.media.duration || video.duration || 0));
  };

  const switchSource = async (sourceId, automatic = false) => {
    if (!EDGE_API_URL || sourceSwitchRef.current || !sourceId || sourceId === state.media?.sourceId) return false;
    const video = videoRef.current;
    const position = Math.max(0, Number(state.media?.startOffset || 0) + Number(video?.currentTime || 0));
    const wasPlaying = Boolean(video && !video.paused);
    sourceSwitchRef.current = true;
    setSourceSwitching(true);
    setIsBuffering(true);
    try {
      for (let attempt = 0; attempt < 35; attempt += 1) {
        const response = await fetch(`${EDGE_API_URL}/api/media/session`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'switch', lookupPath, sourceId, start: position }),
        });
        const replacement = await response.json().catch(() => ({}));
        if (response.ok && replacement.available) {
          autoplayPending.current = wasPlaying;
          resumeAfterSeek.current = wasPlaying;
          setSelectedAudio('');
          setPosition(position);
          setSliderPosition(position);
          setState({ loading: false, media: replacement, error: null });
          return true;
        }
        if (response.status >= 500 && replacement.state === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      if (automatic) setState((current) => ({ ...current, error: 'La vidéo s’est interrompue. Nous cherchons une autre version.' }));
      return false;
    } catch {
      if (automatic) setState((current) => ({ ...current, error: 'La vidéo ne peut pas reprendre pour le moment.' }));
      return false;
    } finally {
      sourceSwitchRef.current = false;
      setSourceSwitching(false);
      setIsBuffering(false);
    }
  };

  const switchToNextSource = () => {
    const sources = state.media?.sources || [];
    const currentIndex = Math.max(0, sources.findIndex((source) => source.id === state.media?.sourceId));
    const next = [...sources.slice(currentIndex + 1), ...sources.slice(0, currentIndex)]
      .find((source) => source.id !== state.media?.sourceId && source.state !== 'failed');
    return next ? switchSource(next.id, true) : Promise.resolve(false);
  };

  useEffect(() => {
    const video = videoRef.current;
    const streamUrl = state.media?.available ? state.media.streamUrl : null;
    if (!video || !streamUrl) return undefined;

    const shouldStartPlayback = autoplayPending.current || resumeAfterSeek.current;
    const startPlayback = async () => {
      if (!shouldStartPlayback) return;
      autoplayPending.current = false;
      resumeAfterSeek.current = false;
      try {
        await video.play();
      } catch {
        // Les navigateurs peuvent refuser l'autoplay avec le son. Dans ce cas,
        // la séance démarre en sourdine et l'utilisateur peut réactiver le son.
        try {
          video.muted = true;
          setIsMuted(true);
          await video.play();
        } catch { /* le bouton Lecture reste disponible */ }
      }
    };
    video.addEventListener('canplay', startPlayback, { once: true });

    const isHls = (() => { try { return new URL(streamUrl, window.location.origin).pathname.endsWith('.m3u8'); } catch { return false; } })();
    if (!isHls) {
      setIsBuffering(true);
      if (['r2', 'origin'].includes(state.media?.provider)) {
        video.src = streamUrl;
      } else {
        const params = new URLSearchParams({ start: String(offset) });
        if (selectedAudio !== '') params.set('audio', selectedAudio);
        video.src = `${streamUrl}?${params}`;
      }
      return () => { video.removeEventListener('canplay', startPlayback); video.removeAttribute('src'); video.load(); };
    }

    if (Hls.isSupported()) {
      const hls = new Hls({
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        backBufferLength: 30,
        liveSyncDurationCount: 5,
        liveMaxLatencyDurationCount: 20,
        manifestLoadingMaxRetry: 6,
        levelLoadingMaxRetry: 8,
        fragLoadingMaxRetry: 8,
        startFragPrefetch: true,
        lowLatencyMode: false,
        nudgeMaxRetry: 10,
        highBufferWatchdogPeriod: 2,
      });
      let networkRetries = 0;
      let mediaRecovered = false;
      let destroyed = false;
      let lastPlaybackPosition = Number(video.currentTime || 0);
      let lastPlaybackProgressAt = Date.now();
      let stallRecoveries = 0;
      hlsRef.current = hls;
      hls.on(Hls.Events.FRAG_LOADED, () => { networkRetries = 0; });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (destroyed) return;
        if (!data?.fatal) {
          if (data?.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
            hls.startLoad(Math.max(0, Number(video.currentTime || 0) - 0.25));
          }
          return;
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 3) {
          networkRetries += 1;
          window.setTimeout(() => {
            if (!destroyed) hls.startLoad(Math.max(0, Number(video.currentTime || 0) - 0.25));
          }, networkRetries * 1000);
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered) {
          mediaRecovered = true;
          hls.recoverMediaError();
          return;
        }
        if ((state.media?.sources || []).some((source) => source.id !== state.media?.sourceId && source.state !== 'failed')) {
          switchToNextSource();
          return;
        }
        setIsBuffering(false);
        setState({ loading: false, media: null, error: 'La vidéo s’est interrompue. Relancez la lecture pour réessayer.' });
      });
      const stallWatchdog = window.setInterval(() => {
        if (destroyed || video.paused || video.ended) {
          lastPlaybackPosition = Number(video.currentTime || 0);
          lastPlaybackProgressAt = Date.now();
          return;
        }
        const currentPosition = Number(video.currentTime || 0);
        if (currentPosition > lastPlaybackPosition + 0.05) {
          lastPlaybackPosition = currentPosition;
          lastPlaybackProgressAt = Date.now();
          stallRecoveries = 0;
          return;
        }
        if (Date.now() - lastPlaybackProgressAt < 4_000) return;
        hls.startLoad(Math.max(0, currentPosition - 0.25));
        if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
          try { video.currentTime = currentPosition + 0.01; } catch { /* le rechargement HLS suffit */ }
        }
        video.play().catch(() => null);
        lastPlaybackProgressAt = Date.now();
        stallRecoveries += 1;
        if (stallRecoveries >= 3 && (state.media?.sources || []).some((source) => source.id !== state.media?.sourceId && source.state !== 'failed')) {
          switchToNextSource();
        }
      }, 2_000);
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
      return () => {
        destroyed = true;
        window.clearInterval(stallWatchdog);
        video.removeEventListener('canplay', startPlayback);
        hlsRef.current = null;
        hls.destroy();
      };
    }

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = streamUrl;
      return () => { video.removeEventListener('canplay', startPlayback); video.removeAttribute('src'); video.load(); };
    }

    setState((current) => ({ ...current, error: 'Cette vidéo ne peut pas être lue avec ce navigateur.' }));
    return undefined;
  // Source switching intentionally uses the media snapshot attached to this HLS instance.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.media, offset, selectedAudio]);

  const sessionMedia = state.media;
  useEffect(() => {
    const media = sessionMedia;
    if (media?.provider !== 'origin' || !media.sessionId || !EDGE_API_URL) return undefined;
    const controller = new AbortController();
    const updateSession = (action = 'heartbeat') => fetch(`${EDGE_API_URL}/api/media/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: media.sessionId, action }), signal: controller.signal,
      keepalive: action === 'close',
    }).catch(() => null);
    updateSession();
    const heartbeat = window.setInterval(updateSession, 30_000);
    return () => {
      clearInterval(heartbeat);
      controller.abort();
      fetch(`${EDGE_API_URL}/api/media/session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: media.sessionId, action: 'close' }), keepalive: true,
      }).catch(() => null);
    };
  }, [lookupPath, sessionMedia]);

  useEffect(() => {
    const media = state.media;
    if (media?.provider !== 'origin' || !media.sessionId || !EDGE_API_URL || (media.sources || []).length >= 3) return undefined;
    let attempts = 0;
    const refreshSources = async () => {
      attempts += 1;
      try {
        const response = await fetch(`${EDGE_API_URL}/api/media/lookup/${lookupPath}`);
        const updated = await response.json().catch(() => ({}));
        if (response.ok && updated.sessionId === media.sessionId && (updated.sources || []).length > (media.sources || []).length) {
          setState((current) => ({ ...current, media: { ...current.media, sources: updated.sources, sourceId: updated.sourceId } }));
        }
      } catch { /* la lecture actuelle reste prioritaire */ }
    };
    const timer = window.setInterval(() => {
      if (attempts >= 12) return window.clearInterval(timer);
      refreshSources();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [lookupPath, state.media]);

  useEffect(() => {
    if (!['r2', 'origin'].includes(state.media?.provider) || selectedAudio === '') return;
    if (hlsRef.current) hlsRef.current.audioTrack = Number(selectedAudio);
    const nativeTracks = videoRef.current?.audioTracks;
    if (nativeTracks) Array.from(nativeTracks).forEach((track, index) => { track.enabled = index === Number(selectedAudio); });
  }, [selectedAudio, state.media]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    Array.from(video.textTracks).forEach((track) => { track.mode = track.id === selectedSubtitle ? 'showing' : 'disabled'; });
  }, [selectedSubtitle, offset, state.media]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const active = document.fullscreenElement === playerRef.current;
      setIsFullscreen(active);
      setControlsVisible(true);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      clearTimeout(controlsTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    const enterNativeFullscreen = () => {
      setIsFullscreen(true);
      setControlsVisible(true);
    };
    const leaveNativeFullscreen = () => {
      setIsFullscreen(false);
      setControlsVisible(true);
    };
    video.addEventListener('webkitbeginfullscreen', enterNativeFullscreen);
    video.addEventListener('webkitendfullscreen', leaveNativeFullscreen);
    return () => {
      video.removeEventListener('webkitbeginfullscreen', enterNativeFullscreen);
      video.removeEventListener('webkitendfullscreen', leaveNativeFullscreen);
    };
  }, [state.media?.streamUrl]);

  useEffect(() => {
    if (!settingsOpen) return undefined;
    const closeSettings = (event) => {
      if (!settingsRef.current?.contains(event.target)) setSettingsOpen(false);
    };
    document.addEventListener('pointerdown', closeSettings);
    return () => document.removeEventListener('pointerdown', closeSettings);
  }, [settingsOpen]);

  useEffect(() => {
    clearTimeout(controlsTimerRef.current);
    if (isFullscreen && isPlaying && !settingsOpen) {
      controlsTimerRef.current = setTimeout(() => setControlsVisible(false), 2500);
    } else {
      setControlsVisible(true);
    }
    return () => clearTimeout(controlsTimerRef.current);
  }, [isFullscreen, isPlaying, settingsOpen]);

  const revealControls = () => {
    if (!isFullscreen) return;
    setControlsVisible(true);
    clearTimeout(controlsTimerRef.current);
    if (isPlaying && !settingsOpen) controlsTimerRef.current = setTimeout(() => setControlsVisible(false), 2500);
  };

  const duration = Number(state.media?.duration || 0);

  useEffect(() => {
    const media = state.media;
    const video = videoRef.current;
    const target = resumePositionRef.current;
    if (!media?.available || !video || resumeAppliedRef.current || target < 3) return undefined;
    resumeAppliedRef.current = true;
    setPosition(target);
    setSliderPosition(target);
    seekTargetRef.current = target;

    if (media.provider === 'origin' && !media.seekable && EDGE_API_URL) {
      seekTo(target);
      return undefined;
    }

    const applyResume = () => {
      const relativeTarget = media.provider === 'origin'
        ? Math.max(0, target - Number(media.startOffset || 0))
        : target;
      try { video.currentTime = relativeTarget; } catch { /* metadata may still be settling */ }
    };
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) applyResume();
    else video.addEventListener('loadedmetadata', applyResume, { once: true });
    return () => video.removeEventListener('loadedmetadata', applyResume);
  // seekTo intentionally uses the current media session and is recreated each render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.media?.streamUrl]);

  useEffect(() => {
    const saveBeforeLeaving = () => persistPlaybackPosition(videoRef.current, true);
    window.addEventListener('pagehide', saveBeforeLeaving);
    return () => {
      window.removeEventListener('pagehide', saveBeforeLeaving);
      saveBeforeLeaving();
    };
  // The cleanup must persist the latest video position, not reinstall on every tick.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupPath, state.media?.streamUrl]);
  const seekTo = async (seconds) => {
    clearTimeout(seekTimerRef.current);
    const target = Math.max(0, Math.min(duration, Number(seconds) || 0));
    const video = videoRef.current;
    resumeAfterSeek.current = Boolean(video && !video.paused);
    seekTargetRef.current = target;
    if (state.media?.provider === 'origin' && !state.media.seekable && EDGE_API_URL) {
      const relativeTarget = Math.max(0, target - Number(state.media.startOffset || 0));
      const ranges = video?.seekable;
      const alreadyGenerated = ranges && Array.from({ length: ranges.length }, (_, index) => index)
        .some((index) => relativeTarget >= ranges.start(index) && relativeTarget <= ranges.end(index));
      if (alreadyGenerated && video) {
        video.currentTime = relativeTarget;
        setPosition(target);
        setSliderPosition(target);
        return;
      }
      const requestId = seekRequestRef.current + 1;
      seekRequestRef.current = requestId;
      seekPendingTargetRef.current = target;
      setIsBuffering(true);
      for (let attempt = 0; attempt < 35 && seekRequestRef.current === requestId; attempt += 1) {
        try {
          const response = await fetch(`${EDGE_API_URL}/api/media/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'seek', lookupPath, start: target }),
          });
          const replacement = await response.json().catch(() => ({}));
          if (response.ok && replacement.available) {
            autoplayPending.current = true;
            setPosition(target);
            setSliderPosition(target);
            setState({ loading: false, media: replacement, error: null });
            return;
          }
        } catch { /* une nouvelle tentative suit */ }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      if (seekRequestRef.current === requestId) {
        seekPendingTargetRef.current = null;
        setIsBuffering(false);
      }
      return;
    }
    if (['r2', 'origin'].includes(state.media?.provider) && videoRef.current) {
      videoRef.current.currentTime = state.media?.provider === 'origin' ? Math.max(0, target - Number(state.media.startOffset || 0)) : target;
      setPosition(target);
      setSliderPosition(target);
      return;
    }
    setOffset(target);
    setPosition(target);
    setSliderPosition(target);
  };
  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  };
  const toggleFullscreen = async () => {
    const player = playerRef.current;
    const video = videoRef.current;
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        const exitFullscreen = document.exitFullscreen || document.webkitExitFullscreen;
        await exitFullscreen?.call(document);
        return;
      }
      const requestFullscreen = player?.requestFullscreen || player?.webkitRequestFullscreen;
      if (requestFullscreen) {
        await requestFullscreen.call(player);
        return;
      }
      // iOS Safari only exposes native fullscreen on the video element.
      if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
    } catch {
      // A native-video fallback also covers browsers that expose but reject
      // element fullscreen on mobile.
      if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
    }
  };
  const formatTime = (seconds) => {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const secs = value % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${minutes}:${String(secs).padStart(2, '0')}`;
  };
  const trackLabel = (track) => {
    const languages = {
      fre: 'Français', fra: 'Français', fr: 'Français',
      eng: 'Anglais', en: 'Anglais', spa: 'Espagnol', es: 'Espagnol',
      ita: 'Italien', it: 'Italien', ger: 'Allemand', deu: 'Allemand', de: 'Allemand',
      por: 'Portugais', pt: 'Portugais', jpn: 'Japonais', ja: 'Japonais',
      und: 'Langue inconnue',
    };
    const language = languages[String(track.language || '').toLowerCase()];
    return language || track.title || String(track.language || 'Langue inconnue').toUpperCase();
  };

  if (state.loading) return <div className="w-full aspect-video bg-black rounded-xl flex items-center justify-center ring-1 ring-white/10"><FaSpinner className="text-3xl text-red-500 animate-spin" /></div>;

  if (state.media?.available) {
    return (
      <div
        ref={playerRef}
        onMouseMove={revealControls}
        onTouchStart={revealControls}
        onKeyDown={revealControls}
        className={`relative overflow-hidden bg-black ring-1 ring-white/10 shadow-[0_0_40px_rgba(0,0,0,0.5)] ${isFullscreen ? `flex h-screen w-screen items-center justify-center rounded-none ${controlsVisible ? 'cursor-default' : 'cursor-none'}` : 'rounded-xl'}`}
      >
        <div className={`relative ${isFullscreen ? 'w-full' : ''}`}>
          <video
            ref={videoRef}
            key={state.media.streamUrl}
            playsInline
            autoPlay
            preload="metadata"
            className={`w-full bg-black ${isFullscreen ? 'max-h-screen' : 'aspect-video'}`}
            title={title}
            onClick={togglePlayback}
            onLoadStart={() => setIsBuffering(true)}
            onWaiting={() => setIsBuffering(true)}
            onSeeking={() => setIsBuffering(true)}
            onCanPlay={() => {
              const pendingTarget = seekPendingTargetRef.current;
              if (pendingTarget === null || Math.abs(Number(state.media?.startOffset || 0) - pendingTarget) < 2) {
                seekPendingTargetRef.current = null;
                setIsBuffering(false);
              }
            }}
            onPlaying={() => setIsBuffering(false)}
            onError={(event) => {
              if (!event.currentTarget.currentSrc) return;
              setIsBuffering(false);
              setState({ loading: false, media: null, error: 'La vidéo ne peut pas être lue. Relancez-la pour réessayer.' });
            }}
            onPlay={(event) => {
              setIsPlaying(true);
              if (!analyticsStartedRef.current) {
                analyticsStartedRef.current = true;
                const base = state.media?.provider === 'origin' ? Number(state.media.startOffset || 0) : state.media?.provider === 'r2' ? 0 : offset;
                analyticsLastPositionRef.current = base + Number(event.currentTarget.currentTime || 0);
                reportPlayback('playback_start', event.currentTarget);
              } else {
                reportPlayback('playback_heartbeat', event.currentTarget);
              }
            }}
            onPause={(event) => {
              setIsPlaying(false);
              persistPlaybackPosition(event.currentTarget, true);
              if (analyticsStartedRef.current && !event.currentTarget.ended) reportPlayback('playback_stop', event.currentTarget);
            }}
            onEnded={(event) => {
              setIsPlaying(false);
              persistPlaybackPosition(event.currentTarget, true);
              reportPlayback('playback_complete', event.currentTarget);
              analyticsStartedRef.current = false;
            }}
            onTimeUpdate={(event) => {
              const base = state.media?.provider === 'origin' ? Number(state.media.startOffset || 0) : state.media?.provider === 'r2' ? 0 : offset;
              const current = Math.min(duration, base + event.currentTarget.currentTime);
              setPosition(current);
              if (!isScrubbingRef.current && seekPendingTargetRef.current === null) {
                seekTargetRef.current = current;
                setSliderPosition(current);
              }
              if (analyticsStartedRef.current && Date.now() - analyticsLastSentAtRef.current >= 30_000) {
                reportPlayback('playback_heartbeat', event.currentTarget);
              }
              persistPlaybackPosition(event.currentTarget);
            }}
          >
            {(state.media.subtitleTracks || []).map((track) => (
              <track key={`${track.index}-${offset}-${selectedSubtitle}`} id={String(track.index)} kind="subtitles" src={`${track.url}?start=${offset}`} srcLang={track.language} label={trackLabel(track)} default={String(track.index) === selectedSubtitle} />
            ))}
          </video>
          {isBuffering && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/45 backdrop-blur-[1px]">
              <div className="flex flex-col items-center gap-1.5 text-white sm:gap-3">
                <FaSpinner className="text-2xl text-red-500 animate-spin sm:text-4xl" />
                <span className="text-[11px] font-medium sm:text-sm">Chargement de la vidéo…</span>
              </div>
            </div>
          )}
        </div>
        {duration > 0 && (
          <div className={`flex min-w-0 items-center gap-1 border-t border-white/10 px-2 py-3 text-white transition-all duration-300 sm:gap-3 sm:px-4 ${isFullscreen ? `absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black via-black/90 to-black/70 pb-6 pt-5 ${controlsVisible ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-full opacity-0'}` : 'bg-zinc-950'}`}>
            <button type="button" onClick={togglePlayback} aria-label={isPlaying ? 'Pause' : 'Lecture'} className="shrink-0 rounded p-2 hover:bg-white/10">{isPlaying ? <FaPause /> : <FaPlay />}</button>
            <span className="hidden w-16 text-right text-xs tabular-nums text-gray-300 sm:inline">{formatTime(sliderPosition)}</span>
            <span className="w-[4.5rem] shrink-0 text-[10px] tabular-nums text-gray-300 sm:hidden">{formatTime(sliderPosition)} / {formatTime(duration)}</span>
            <input
              type="range"
              min="0"
              max={duration}
              step="1"
              value={sliderPosition}
              onChange={(event) => {
                const target = Number(event.target.value);
                seekTargetRef.current = target;
                setSliderPosition(target);
                // Safari and some mobile browsers do not reliably emit
                // pointerup on range inputs. Trigger after the thumb stops as
                // a universal fallback; pointerup still fires immediately
                // where supported.
                clearTimeout(seekTimerRef.current);
                seekTimerRef.current = setTimeout(() => {
                  isScrubbingRef.current = false;
                  seekTo(seekTargetRef.current);
                }, 500);
              }}
              onPointerDown={(event) => {
                isScrubbingRef.current = true;
                seekTargetRef.current = Number(event.currentTarget.value);
                event.currentTarget.setPointerCapture?.(event.pointerId);
              }}
              onPointerUp={(event) => {
                clearTimeout(seekTimerRef.current);
                if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                isScrubbingRef.current = false;
                seekTo(seekTargetRef.current);
              }}
              onPointerCancel={() => {
                isScrubbingRef.current = false;
                const video = videoRef.current;
                const base = state.media?.provider === 'origin' ? Number(state.media.startOffset || 0) : state.media?.provider === 'r2' ? 0 : offset;
                const current = Math.min(duration, base + (video?.currentTime || 0));
                seekTargetRef.current = current;
                setSliderPosition(current);
              }}
              onKeyDown={() => { isScrubbingRef.current = true; }}
              onKeyUp={() => {
                isScrubbingRef.current = false;
                seekTo(seekTargetRef.current);
              }}
              className="h-1 min-w-0 flex-1 cursor-pointer accent-red-600"
              aria-label="Position dans le film"
            />
            <span className="hidden w-16 text-xs tabular-nums text-gray-300 sm:inline">{formatTime(duration)}</span>
            {((state.media.audioTracks || []).length > 0 || (state.media.subtitleTracks || []).length > 0) && (
              <div ref={settingsRef} className="relative">
                <button
                  type="button"
                  onClick={() => setSettingsOpen((open) => !open)}
                  aria-label="Réglages audio et sous-titres"
                  aria-expanded={settingsOpen}
                  className={`shrink-0 rounded p-2 hover:bg-white/10 ${settingsOpen ? 'bg-white/15 text-red-400' : ''}`}
                ><FaCog /></button>
                {settingsOpen && (
                  <div className="absolute bottom-12 right-0 z-30 w-64 rounded-xl border border-white/10 bg-zinc-950/95 p-4 text-left shadow-2xl backdrop-blur">
                    <p className="mb-3 text-sm font-semibold text-white">Lecture</p>
                    {(state.media.sources || []).length > 1 && (
                      <label className="mb-3 block text-xs font-medium text-gray-300">
                        Version de lecture
                        <select
                          value={state.media.sourceId || state.media.sources.find((source) => source.selected)?.id || ''}
                          disabled={sourceSwitching}
                          onChange={(event) => switchSource(event.target.value)}
                          className="mt-1.5 w-full rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-red-500 disabled:opacity-60"
                        >
                          {state.media.sources.map((source, index) => (
                            <option key={source.id} value={source.id}>{`Option ${index + 1}`}</option>
                          ))}
                        </select>
                        <span className="mt-1.5 block text-[11px] font-normal text-gray-500">
                          {sourceSwitching ? 'Changement en cours…' : 'Une autre option sera essayée automatiquement en cas de problème.'}
                        </span>
                      </label>
                    )}
                    {(state.media.audioTracks || []).length > 0 && (
                      <label className="mb-3 block text-xs font-medium text-gray-300">
                        Audio
                        <select
                          value={selectedAudio || String(state.media.audioTracks[0].index)}
                          onChange={(event) => {
                            if (['r2', 'origin'].includes(state.media?.provider)) {
                              setSelectedAudio(event.target.value);
                              return;
                            }
                            const video = videoRef.current;
                            const exactPosition = Math.min(duration, offset + (video?.currentTime || 0));
                            resumeAfterSeek.current = true;
                            setPosition(exactPosition);
                            setSliderPosition(exactPosition);
                            setOffset(exactPosition);
                            setSelectedAudio(event.target.value);
                          }}
                          className="mt-1.5 w-full rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-red-500"
                        >
                          {state.media.audioTracks.map((track) => <option key={track.index} value={track.index}>{trackLabel(track)}</option>)}
                        </select>
                        {state.media.audioTracks.length === 1 && <span className="mt-1.5 block text-[11px] font-normal text-gray-500">Une seule piste audio est disponible.</span>}
                      </label>
                    )}
                    {(state.media.subtitleTracks || []).length > 0 && (
                      <label className="block text-xs font-medium text-gray-300">
                        Sous-titres
                        <select
                          value={selectedSubtitle}
                          onChange={(event) => setSelectedSubtitle(event.target.value)}
                          className="mt-1.5 w-full rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-red-500"
                        >
                          <option value="off">Désactivés</option>
                          {state.media.subtitleTracks.map((track) => <option key={track.index} value={track.index}>{trackLabel(track)}</option>)}
                        </select>
                      </label>
                    )}
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                const video = videoRef.current;
                if (!video) return;
                video.muted = !video.muted;
                setIsMuted(video.muted);
              }}
              aria-label={isMuted ? 'Activer le son' : 'Couper le son'}
              className="shrink-0 rounded p-2 hover:bg-white/10"
            >{isMuted ? <FaVolumeMute /> : <FaVolumeUp />}</button>
            <button
              type="button"
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? 'Quitter le plein écran' : 'Plein écran'}
              className="shrink-0 rounded p-2 hover:bg-white/10"
            ><FaExpand /></button>
          </div>
        )}
      </div>
    );
  }

  if (requestState.pending) return (
    <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl bg-black ring-1 ring-white/10 shadow-[0_0_40px_rgba(0,0,0,0.5)]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(220,38,38,0.16),transparent_60%)]" />
      <div className="relative w-full max-w-lg px-4 py-3 text-center sm:px-8 sm:py-6">
        <div className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-full border border-red-500/30 bg-red-500/10 sm:mb-5 sm:h-16 sm:w-16">
          <FaSpinner className="text-xl text-red-500 animate-spin sm:text-3xl" />
        </div>
        <h3 className="mb-1 text-sm font-semibold text-white sm:mb-2 sm:text-xl">La séance arrive !</h3>
        <p className="mb-1 line-clamp-2 min-h-0 text-[11px] leading-4 text-gray-300 sm:mb-2 sm:min-h-6 sm:text-sm sm:leading-6">
          {waitingStatusText(requestState)}
        </p>
        <p className="mb-2 text-[11px] font-medium tabular-nums text-red-300 sm:mb-6 sm:text-sm">
          {['calculated', 'estimated'].includes(requestState.etaKind) && Number.isFinite(requestState.etaSeconds)
            ? requestState.etaSeconds > 0
              ? `${requestState.etaKind === 'calculated' ? 'Temps restant' : 'Temps restant estimé'} : ${formatEta(requestState.etaSeconds)}`
              : 'Dernières vérifications…'
            : requestState.heartbeatAt
              ? 'Votre vidéo est bien en cours de préparation…'
              : 'Démarrage de la préparation…'}
        </p>
        <div className="h-1.5 overflow-hidden rounded-full bg-white/10 sm:h-2" role="progressbar" aria-label="Préparation du média" aria-valuemin="0" aria-valuemax="100" aria-valuenow={requestState.progress}>
          <div className={`h-full rounded-full bg-gradient-to-r from-red-700 via-red-500 to-orange-400 transition-all duration-700 ${requestState.progressMode === 'indeterminate' ? 'animate-pulse' : ''}`} style={{ width: `${requestState.progressMode === 'indeterminate' ? Math.max(12, requestState.progress) : requestState.progress}%` }} />
        </div>
        <p className="mt-3 hidden text-xs text-gray-500 sm:block">Vous pouvez rester ici : la lecture apparaîtra automatiquement dès qu’elle sera prête.</p>
      </div>
    </div>
  );

  if (requestState.unavailable) return (
    <div className="flex aspect-video w-full items-center justify-center rounded-xl bg-black ring-1 ring-white/10 shadow-[0_0_40px_rgba(0,0,0,0.5)]">
      <div className="max-w-lg px-8 text-center">
        <h3 className="mb-2 text-xl font-semibold text-white">Indisponible pour le moment</h3>
        <p className="text-sm leading-6 text-gray-400">
          {normalizeProvisionMessage(requestState.message || requestState.error) || 'Ce contenu n’est pas disponible pour le moment.'}
        </p>
        <button
          type="button"
          onClick={() => setRetryNonce((value) => value + 1)}
          className="mt-5 rounded-lg bg-red-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-red-500"
        >
          Réessayer la lecture
        </button>
      </div>
    </div>
  );

  return (
    <div className="w-full aspect-video bg-black rounded-xl flex items-center justify-center ring-1 ring-white/10 shadow-[0_0_40px_rgba(0,0,0,0.5)]">
      <div className="max-w-lg px-8 text-center">
        <FaPlay className="mx-auto mb-4 text-3xl text-red-500" />
        <h3 className="mb-2 text-xl font-semibold text-white">Indisponible pour le moment</h3>
        <p className="mb-5 text-sm leading-6 text-gray-400">{normalizeProvisionMessage(state.error) || unavailableText}</p>
        <button type="button" onClick={() => setRetryNonce((value) => value + 1)} className="mr-3 inline-flex rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500">Réessayer</button>
        <a href={seerrUrl} target="_blank" rel="noreferrer" className="inline-flex rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500">Voir ma demande</a>
      </div>
    </div>
  );
};

JellyfinPlayer.propTypes = { lookupPath: PropTypes.string.isRequired, title: PropTypes.string, unavailableText: PropTypes.string.isRequired };
export default JellyfinPlayer;
