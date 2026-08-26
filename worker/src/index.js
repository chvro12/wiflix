const json = (payload, status = 200, headers = {}) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
});

const corsHeaders = (request, env) => {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim());
  return allowed.includes(origin) ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range, X-Admin-Username, X-Admin-Password',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag',
    Vary: 'Origin',
  } : {};
};

const proxyTmdb = async (request, env, url, headers) => {
  if (!env.TMDB_API_KEY) return json({ error: 'Catalogue temporairement indisponible.' }, 503, headers);
  const relativePath = url.pathname.slice('/api/tmdb'.length);
  if (!/^\/(discover|trending|search|movie|tv|find|genre)(\/|$)/.test(relativePath) || relativePath.includes('..')) {
    return json({ error: 'Route catalogue invalide.' }, 400, headers);
  }

  const upstream = new URL(`https://api.themoviedb.org/3${relativePath}`);
  for (const [key, value] of url.searchParams) {
    if (key !== 'api_key') upstream.searchParams.append(key, value);
  }
  upstream.searchParams.set('api_key', env.TMDB_API_KEY);
  if (!upstream.searchParams.has('language')) upstream.searchParams.set('language', 'fr-FR');

  const cacheKey = new Request(upstream.toString(), { method: 'GET' });
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const response = new Response(cached.body, cached);
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    response.headers.set('X-WeFlix-Cache', 'HIT');
    return response;
  }

  let upstreamResponse = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      upstreamResponse = await fetch(upstream, {
        headers: { Accept: 'application/json' },
        cf: { cacheEverything: true, cacheTtl: 600 },
      });
      if (upstreamResponse.ok || ![429, 500, 502, 503, 504].includes(upstreamResponse.status)) break;
    } catch {
      if (attempt === 2) return json({ error: 'Catalogue temporairement indisponible.' }, 502, headers);
    }
  }
  if (!upstreamResponse) return json({ error: 'Catalogue temporairement indisponible.' }, 502, headers);

  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', upstreamResponse.headers.get('Content-Type') || 'application/json; charset=utf-8');
  responseHeaders.set('Cache-Control', upstreamResponse.ok ? 'public, max-age=300, s-maxage=600' : 'no-store');
  responseHeaders.set('X-WeFlix-Cache', 'MISS');
  const response = new Response(upstreamResponse.body, { status: upstreamResponse.status, headers: responseHeaders });
  if (upstreamResponse.ok) await caches.default.put(cacheKey, response.clone());
  return response;
};

const verifyFirebaseToken = async (request, env) => {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token || !env.FIREBASE_API_KEY) return null;
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_API_KEY)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }),
  });
  if (!response.ok) return null;
  const body = await response.json();
  return body.users?.[0] || null;
};

const toBase64Url = (bytes) => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const signMediaPath = async (path, expires, secret) => {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${path}\n${expires}`));
  return toBase64Url(new Uint8Array(signature));
};

const hasValidSignature = async (url, env) => {
  const expires = Number(url.searchParams.get('expires'));
  const received = url.searchParams.get('signature') || '';
  if (!env.MEDIA_SIGNING_KEY || !received || !Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000)) return false;
  const expected = await signMediaPath(url.pathname, expires, env.MEDIA_SIGNING_KEY);
  return received === expected;
};

// A signed playlist must remain usable for the whole screening. Five minutes
// caused long films to stop as soon as the player needed a later segment.
const MEDIA_URL_TTL_SECONDS = 12 * 60 * 60;

const signedMediaUrl = async (origin, key, env, expires = Math.floor(Date.now() / 1000) + MEDIA_URL_TTL_SECONDS) => {
  const path = `/media/${key.split('/').map(encodeURIComponent).join('/')}`;
  const signature = await signMediaPath(path, expires, env.MEDIA_SIGNING_KEY);
  return `${origin}${path}?expires=${expires}&signature=${signature}`;
};

const lookupOriginMedia = async (lookupPath, env, directOnly = false) => {
  if (!env.MEDIA_ORIGIN_URL || !env.MEDIA_ORIGIN_TOKEN) return null;
  try {
    const response = await fetch(`${String(env.MEDIA_ORIGIN_URL).replace(/\/$/, '')}/playback/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.MEDIA_ORIGIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lookupPath, directOnly }),
    });
    if (![200, 202, 503].includes(response.status)) return null;
    const payload = await response.json();
    if (payload.available) return payload;
    if (payload.state === 'failed') return { ...payload, available: false, preparing: false, failed: true };
    return { ...payload, available: false, preparing: true, state: payload.state || 'preparing' };
  } catch {
    return null;
  }
};

const updateOriginSession = async (request, env, headers) => {
  if (!env.MEDIA_ORIGIN_URL || !env.MEDIA_ORIGIN_TOKEN) return json({ error: 'Origine indisponible' }, 503, headers);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSON invalide' }, 400, headers); }
  if (body.action === 'seek' || body.action === 'switch') {
    const lookupPath = String(body.lookupPath || '');
    const start = Math.max(0, Number(body.start) || 0);
    const sourceId = /^[A-Za-z0-9_-]{8,32}$/.test(String(body.sourceId || '')) ? String(body.sourceId) : '';
    if (!/^(movie\/\d+|episode\/\d+\/\d+\/\d+)$/.test(lookupPath)) return json({ error: 'Média invalide' }, 400, headers);
    try {
      const response = await fetch(`${String(env.MEDIA_ORIGIN_URL).replace(/\/$/, '')}/playback/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.MEDIA_ORIGIN_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ lookupPath, start, sourceId }),
      });
      const payload = await response.json().catch(() => ({}));
      return json(payload, response.status, headers);
    } catch {
      return json({ error: 'Origine indisponible' }, 503, headers);
    }
  }
  const sessionId = String(body.sessionId || '');
  const action = body.action === 'close' ? 'close' : 'heartbeat';
  if (!/^[a-f0-9-]{20,64}$/i.test(sessionId)) return json({ error: 'Session invalide' }, 400, headers);
  try {
    const response = await fetch(`${String(env.MEDIA_ORIGIN_URL).replace(/\/$/, '')}/playback/session/${sessionId}/${action}`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.MEDIA_ORIGIN_TOKEN}` },
    });
    return new Response(null, { status: response.status, headers });
  } catch {
    return json({ error: 'Origine indisponible' }, 503, headers);
  }
};

const resolveMediaReference = (baseKey, reference) => {
  const directory = baseKey.includes('/') ? baseKey.slice(0, baseKey.lastIndexOf('/') + 1) : '';
  return new URL(reference, `https://r2.local/${directory}`).pathname.slice(1);
};

const r2HlsIsImmediatelyPlayable = async (bucket, masterKey) => {
  try {
    const masterObject = await bucket.get(masterKey);
    if (!masterObject) return false;
    const master = await masterObject.text();
    let mediaKey = masterKey;
    let mediaPlaylist = master;
    if (!/^#EXTINF:/m.test(master)) {
      const variant = master.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('#'));
      if (!variant) return false;
      mediaKey = resolveMediaReference(masterKey, variant);
      const mediaObject = await bucket.get(mediaKey);
      if (!mediaObject) return false;
      mediaPlaylist = await mediaObject.text();
    }
    const segment = mediaPlaylist.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('#'));
    if (!segment) return false;
    return Boolean(await bucket.head(resolveMediaReference(mediaKey, segment)));
  } catch {
    return false;
  }
};

const lookupMedia = async (request, env, url, headers) => {
  const lookupPath = decodeURIComponent(url.pathname.slice('/api/media/lookup/'.length)).replace(/^\/+|\/+$/g, '');
  if (!lookupPath || !/^[a-z0-9/_-]+$/i.test(lookupPath) || lookupPath.includes('..')) {
    return json({ error: 'Identifiant média invalide' }, 400, headers);
  }
  // A Comet-resolved source that is already browser-compatible is the fastest
  // path and remains the primary delivery source. The direct-only probe never
  // starts an HLS transcode, so an existing R2 copy is not penalized when the
  // origin source needs remuxing.
  const directOrigin = await lookupOriginMedia(lookupPath, env, true);
  if (directOrigin?.available && directOrigin.deliveryMode === 'direct_range') {
    return json(directOrigin, 200, headers);
  }
  const manifestObject = await env.MEDIA.get(`catalog/${lookupPath}.json`);
  if (!manifestObject) {
    const origin = await lookupOriginMedia(lookupPath, env);
    return origin?.available ? json(origin, 200, headers) : json(origin || { available: false }, origin?.failed ? 503 : 404, headers);
  }
  let manifest;
  try { manifest = await manifestObject.json(); } catch { return json({ error: 'Manifeste média invalide' }, 500, headers); }
  if (!manifest.key || typeof manifest.key !== 'string' || manifest.key.includes('..')) {
    return json({ error: 'Clé média invalide' }, 500, headers);
  }
  const duration = Number(manifest.duration) || 0;
  const minimumDuration = lookupPath.startsWith('movie/') ? 20 * 60 : 4 * 60;
  if (duration < minimumDuration) {
    // Old test uploads and interrupted encodes must never be advertised as a
    // playable film. Returning 404 lets the client fall back to Jellyfin while
    // the importer rebuilds a valid R2 copy.
    const origin = await lookupOriginMedia(lookupPath, env);
    if (origin?.failed) return json(origin, 503, headers);
    return origin?.available ? json(origin, 200, headers) : json({ available: false, rebuilding: true, preparing: Boolean(origin?.preparing) }, 404, headers);
  }
  if (!await r2HlsIsImmediatelyPlayable(env.MEDIA, manifest.key)) {
    const origin = await lookupOriginMedia(lookupPath, env);
    if (origin?.failed) return json(origin, 503, headers);
    return origin?.available
      ? json(origin, 200, headers)
      : json({ available: false, rebuilding: true, preparing: Boolean(origin?.preparing) }, 404, headers);
  }
  const expires = Math.floor(Date.now() / 1000) + MEDIA_URL_TTL_SECONDS;
  return json({
    available: true,
    provider: 'r2',
    name: manifest.title || lookupPath,
    duration,
    streamUrl: await signedMediaUrl(url.origin, manifest.key, env, expires),
    audioTracks: manifest.audioTracks || [],
    subtitleTracks: manifest.subtitleTracks || [],
  }, 200, headers);
};

const requestMedia = async (request, env, headers) => {
  const user = await verifyFirebaseToken(request, env);
  if (!user) return json({ error: 'Authentification requise' }, 401, headers);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSON invalide' }, 400, headers); }
  const mediaId = Number(body.mediaId);
  const mediaType = body.mediaType === 'tv' ? 'tv' : body.mediaType === 'movie' ? 'movie' : '';
  const season = Number(body.season);
  const episode = Number(body.episode);
  if (!Number.isInteger(mediaId) || mediaId <= 0 || !mediaType) return json({ error: 'Média invalide' }, 400, headers);
  const payload = { mediaType, mediaId };
  if (mediaType === 'tv') {
    payload.seasons = [Number.isInteger(season) && season > 0 ? season : 1];
    payload.episode = Number.isInteger(episode) && episode > 0 ? episode : 1;
  }
  const lookupPath = mediaType === 'movie'
    ? `movie/${mediaId}`
    : `episode/${mediaId}/${payload.seasons[0]}/${payload.episode}`;
  const cachedManifest = await env.MEDIA.get(`catalog/${lookupPath}.json`);
  if (cachedManifest) {
    try {
      const manifest = await cachedManifest.json();
      const minimumDuration = mediaType === 'movie' ? 20 * 60 : 4 * 60;
      if (Number(manifest.duration) >= minimumDuration && manifest.key && await r2HlsIsImmediatelyPlayable(env.MEDIA, manifest.key)) {
        return json({ requested: false, pending: false, available: true, provider: 'r2' }, 200, headers);
      }
    } catch { /* une copie R2 invalide doit être reconstruite */ }
  }
  if (!env.SEERR_URL || !env.SEERR_API_KEY) {
    const requestId = `${Date.now()}-${crypto.randomUUID()}`;
    await env.MEDIA.put(`requests/pending/${requestId}.json`, JSON.stringify({
      ...payload,
      requestId,
      userId: user.localId || user.email || 'unknown',
      createdAt: new Date().toISOString(),
    }), { httpMetadata: { contentType: 'application/json' } });
    return json({ requested: true, pending: true, queued: true, requestId }, 202, headers);
  }
  try {
    const seerrBaseUrl = String(env.SEERR_URL).replace(/\/$/, '');
    const seerrHeaders = { 'Content-Type': 'application/json', 'X-Api-Key': env.SEERR_API_KEY };
    const existingResponse = await fetch(`${seerrBaseUrl}/api/v1/${mediaType}/${mediaId}`, { headers: seerrHeaders });
    if (existingResponse.ok) {
      const existing = await existingResponse.json();
      const activeRequests = (existing.mediaInfo?.requests || []).filter((item) => [1, 2].includes(Number(item.status)));
      const alreadyPending = mediaType === 'movie'
        ? activeRequests.length > 0
        : activeRequests.some((item) => (item.seasons || []).some((requestedSeason) => Number(requestedSeason.seasonNumber) === payload.seasons[0]));
      if (alreadyPending) return json({ requested: false, pending: true, requestId: activeRequests[0]?.id || null }, 202, headers);
    }
    const response = await fetch(`${seerrBaseUrl}/api/v1/request`, {
      method: 'POST',
      headers: seerrHeaders,
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok || response.status === 409) {
      return json({ requested: response.ok, pending: true, requestId: result.id || null }, 202, headers);
    }
    return json({ error: result.message || 'Seerr a refusé la demande' }, response.status, headers);
  } catch {
    return json({ error: 'Seerr temporairement indisponible' }, 502, headers);
  }
};

const authorizedRequestBridge = (request, env) => {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  return Boolean(env.REQUEST_PULL_SECRET && token && token === env.REQUEST_PULL_SECRET);
};

const pullQueuedRequests = async (request, env, headers) => {
  if (!authorizedRequestBridge(request, env)) return json({ error: 'Non autorisé' }, 401, headers);
  const listing = await env.MEDIA.list({ prefix: 'requests/pending/', limit: 10 });
  const requests = [];
  for (const item of listing.objects) {
    const object = await env.MEDIA.get(item.key);
    if (!object) continue;
    try { requests.push({ key: item.key, body: await object.json() }); } catch { /* objet invalide ignoré */ }
  }
  return json({ requests }, 200, headers);
};

const enqueueBridgeRequest = async (request, env, headers) => {
  if (!authorizedRequestBridge(request, env)) return json({ error: 'Non autorisé' }, 401, headers);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSON invalide' }, 400, headers); }
  const mediaId = Number(body.mediaId);
  const mediaType = body.mediaType === 'tv' ? 'tv' : body.mediaType === 'movie' ? 'movie' : '';
  const season = Number(body.season);
  const episode = Number(body.episode);
  if (!Number.isInteger(mediaId) || mediaId <= 0 || !mediaType) return json({ error: 'Média invalide' }, 400, headers);
  const requestId = `${Date.now()}-${crypto.randomUUID()}`;
  const payload = { mediaType, mediaId, requestId, userId: 'request-bridge', createdAt: new Date().toISOString() };
  if (mediaType === 'tv') {
    payload.seasons = [Number.isInteger(season) && season > 0 ? season : 1];
    payload.episode = Number.isInteger(episode) && episode > 0 ? episode : 1;
  }
  const key = `requests/pending/${requestId}.json`;
  await env.MEDIA.put(key, JSON.stringify(payload), { httpMetadata: { contentType: 'application/json' } });
  return json({ queued: true, key }, 202, headers);
};

const acknowledgeQueuedRequest = async (request, env, headers) => {
  if (!authorizedRequestBridge(request, env)) return json({ error: 'Non autorisé' }, 401, headers);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSON invalide' }, 400, headers); }
  const key = String(body.key || '');
  if (!/^requests\/pending\/[a-z0-9-]+\.json$/i.test(key)) return json({ error: 'Clé invalide' }, 400, headers);
  const object = await env.MEDIA.get(key);
  if (object) {
    await env.MEDIA.put(key.replace('/pending/', '/processed/'), object.body, { httpMetadata: object.httpMetadata });
    await env.MEDIA.delete(key);
  }
  return json({ acknowledged: true }, 200, headers);
};

const provisionStatus = async (request, env, url, headers) => {
  const user = await verifyFirebaseToken(request, env);
  if (!user) return json({ error: 'Authentification requise' }, 401, headers);
  const lookupPath = decodeURIComponent(url.pathname.slice('/api/media/status/'.length)).replace(/^\/+|\/+$/g, '');
  if (!/^(movie\/\d+|episode\/\d+\/\d+\/\d+)$/.test(lookupPath)) return json({ error: 'Média invalide' }, 400, headers);
  const object = await env.MEDIA.get(`requests/status/${lookupPath}.json`);
  if (!object) return json({ status: 'unknown', lookupPath }, 404, headers);
  try { return json(await object.json(), 200, headers); }
  catch { return json({ error: 'Statut média invalide' }, 500, headers); }
};

const verifyTurnstile = async (request, env, headers) => {
  if (!env.TURNSTILE_SECRET_KEY) return json({ error: 'Turnstile non configuré' }, 503, headers);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSON invalide' }, 400, headers); }
  if (!body.token || typeof body.token !== 'string' || body.token.length > 2048) {
    return json({ error: 'Validation anti-robot requise' }, 400, headers);
  }
  const form = new FormData();
  form.set('secret', env.TURNSTILE_SECRET_KEY);
  form.set('response', body.token);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) form.set('remoteip', ip);
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const result = await response.json();
  return result.success
    ? json({ success: true }, 200, headers)
    : json({ error: 'Validation anti-robot refusée' }, 403, headers);
};

const analyticsJson = async (bucket, key) => {
  const object = await bucket.get(key);
  if (!object) return null;
  try { return await object.json(); } catch { return null; }
};

const analyticsPut = (bucket, key, value) => bucket.put(key, JSON.stringify(value), {
  httpMetadata: { contentType: 'application/json' },
});

const safeAnalyticsText = (value, maximum = 160) => String(value || '').trim().slice(0, maximum);

const analyticsEvent = async (request, env, headers) => {
  const user = await verifyFirebaseToken(request, env);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSON invalide' }, 400, headers); }
  const allowedTypes = new Set(['presence', 'presence_leave', 'page_view', 'playback_start', 'playback_heartbeat', 'playback_stop', 'playback_complete']);
  const type = safeAnalyticsText(body.type, 40);
  if (!allowedTypes.has(type)) return json({ error: 'Événement invalide' }, 400, headers);

  const anonymousId = safeAnalyticsText(body.visitorId, 100);
  if (!user && !/^[a-z0-9_-]{8,100}$/i.test(anonymousId)) return json({ error: 'Visiteur invalide' }, 400, headers);
  const userId = safeAnalyticsText(user?.localId || user?.email || `guest:${anonymousId}`, 160);
  if (!userId) return json({ error: 'Utilisateur invalide' }, 400, headers);
  const userKey = encodeURIComponent(userId);
  const now = new Date().toISOString();
  const profile = {
    userId,
    email: safeAnalyticsText(user?.email, 200),
    displayName: safeAnalyticsText(user?.displayName || user?.email?.split('@')[0] || `Visiteur ${anonymousId.slice(-4).toUpperCase()}`, 100),
    photoUrl: safeAnalyticsText(user?.photoUrl, 500),
    emailVerified: Boolean(user?.emailVerified),
    providers: (user?.providerUserInfo || []).map((provider) => safeAnalyticsText(provider.providerId, 80)).filter(Boolean),
    isGuest: !user,
    lastSeenAt: now,
  };
  const path = safeAnalyticsText(body.path, 300);
  const title = safeAnalyticsText(body.title, 200);
  const lookupPath = safeAnalyticsText(body.lookupPath, 100);
  const mediaType = body.mediaType === 'movie' ? 'movie' : body.mediaType === 'episode' ? 'episode' : '';
  const position = Math.max(0, Number(body.position) || 0);
  const duration = Math.max(0, Number(body.duration) || 0);
  const secondsViewed = Math.max(0, Math.min(60, Number(body.secondsViewed) || 0));

  if (type === 'presence_leave') {
    await Promise.all([
      env.MEDIA.delete(`analytics/presence/${userKey}.json`),
      env.MEDIA.delete(`analytics/watching/${userKey}.json`),
    ]);
    return json({ ok: true }, 202, headers);
  }

  // Presence pulses must not rewrite the cumulative user document: otherwise
  // a simultaneous page-view/playback event can be overwritten with stale R2
  // counters. The client also serializes events from each browser tab.
  if (!['presence', 'playback_stop'].includes(type)) {
    const previousUser = await analyticsJson(env.MEDIA, `analytics/users/${userKey}.json`) || {};
    const userStats = {
      ...previousUser,
      ...profile,
      firstSeenAt: previousUser.firstSeenAt || now,
      pageViews: Number(previousUser.pageViews || 0) + (type === 'page_view' ? 1 : 0),
      playbackStarts: Number(previousUser.playbackStarts || 0) + (type === 'playback_start' ? 1 : 0),
      completions: Number(previousUser.completions || 0) + (type === 'playback_complete' ? 1 : 0),
      watchSeconds: Number(previousUser.watchSeconds || 0) + (type === 'playback_heartbeat' ? secondsViewed : 0),
    };
    await analyticsPut(env.MEDIA, `analytics/users/${userKey}.json`, userStats);
  }
  await analyticsPut(env.MEDIA, `analytics/presence/${userKey}.json`, { ...profile, path, title });

  if (lookupPath && ['playback_start', 'playback_heartbeat', 'playback_stop', 'playback_complete'].includes(type)) {
    const mediaKey = encodeURIComponent(lookupPath);
    const previousMedia = await analyticsJson(env.MEDIA, `analytics/media/${mediaKey}.json`) || {};
    await analyticsPut(env.MEDIA, `analytics/media/${mediaKey}.json`, {
      ...previousMedia,
      lookupPath,
      title: title || previousMedia.title || lookupPath,
      mediaType: mediaType || previousMedia.mediaType || 'unknown',
      views: Number(previousMedia.views || 0) + (type === 'playback_start' ? 1 : 0),
      completions: Number(previousMedia.completions || 0) + (type === 'playback_complete' ? 1 : 0),
      watchSeconds: Number(previousMedia.watchSeconds || 0) + (type === 'playback_heartbeat' ? secondsViewed : 0),
      lastViewedAt: now,
    });
    if (['playback_complete', 'playback_stop'].includes(type)) {
      await env.MEDIA.delete(`analytics/watching/${userKey}.json`);
    } else {
      await analyticsPut(env.MEDIA, `analytics/watching/${userKey}.json`, {
        ...profile, lookupPath, title, mediaType, position, duration,
        progress: duration > 0 ? Math.min(100, Math.round((position / duration) * 100)) : 0,
        provider: safeAnalyticsText(body.provider, 40),
      });
    }
  }

  if (['page_view', 'playback_start', 'playback_complete'].includes(type)) {
    const eventKey = `analytics/events/${Date.now()}-${crypto.randomUUID()}.json`;
    await analyticsPut(env.MEDIA, eventKey, { type, ...profile, path, title, lookupPath, mediaType, position, duration, createdAt: now });
  }
  return json({ ok: true }, 202, headers);
};

const analyticsList = async (bucket, prefix, maximum = 5000) => {
  const objects = [];
  let cursor;
  do {
    const remaining = maximum - objects.length;
    if (remaining <= 0) break;
    const page = await bucket.list({ prefix, cursor, limit: Math.min(1000, remaining) });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && objects.length < maximum);
  return objects;
};

const analyticsValues = async (bucket, objects) => {
  const values = [];
  // R2 binding reads do not use outbound HTTP sockets. Reading wider batches
  // keeps the admin dashboard responsive as the catalogue grows while still
  // bounding memory and concurrent work inside one Worker invocation.
  for (let index = 0; index < objects.length; index += 64) {
    const batch = await Promise.all(objects.slice(index, index + 64).map((item) => (
      analyticsJson(bucket, item.key).catch(() => null)
    )));
    values.push(...batch.filter(Boolean));
  }
  return values;
};

const adminCredentialsMatch = async (request, env) => {
  const expectedUsername = String(env.ADMIN_USERNAME || 'admin');
  const expectedPassword = String(env.ADMIN_PASSWORD || '');
  const bearer = String(request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (bearer.startsWith('admin.')) {
    const [, expiresValue, receivedSignature] = bearer.split('.');
    const expires = Number(expiresValue);
    const sessionSecret = String(env.ADMIN_SESSION_SECRET || expectedPassword);
    if (sessionSecret && receivedSignature && Number.isSafeInteger(expires) && expires >= Math.floor(Date.now() / 1000)) {
      const expectedSignature = await signMediaPath(`/admin/${expectedUsername}`, expires, sessionSecret);
      if (receivedSignature === expectedSignature) return true;
    }
  }
  const receivedUsername = String(request.headers.get('X-Admin-Username') || '');
  const receivedPassword = String(request.headers.get('X-Admin-Password') || '');
  if (!expectedUsername || !expectedPassword || !receivedUsername || !receivedPassword) return false;
  const digest = async (value) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [left, right] = await Promise.all([
    digest(`${expectedUsername}\n${expectedPassword}`),
    digest(`${receivedUsername}\n${receivedPassword}`),
  ]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
};

const createAdminSession = async (request, env, headers) => {
  if (!await adminCredentialsMatch(request, env)) return json({ error: 'Identifiants administrateur incorrects' }, 401, headers);
  const username = String(env.ADMIN_USERNAME || 'admin');
  const sessionSecret = String(env.ADMIN_SESSION_SECRET || env.ADMIN_PASSWORD || '');
  if (!sessionSecret) return json({ error: 'Session administrateur indisponible' }, 503, headers);
  const expires = Math.floor(Date.now() / 1000) + (12 * 60 * 60);
  const signature = await signMediaPath(`/admin/${username}`, expires, sessionSecret);
  return json({ token: `admin.${expires}.${signature}`, expiresAt: new Date(expires * 1000).toISOString() }, 200, headers);
};

const publicCatalogueAvailability = async (env, headers) => {
  const cacheKey = new Request('https://weflix.internal/catalogue-available-v1', { method: 'GET' });
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const response = new Response(cached.body, cached);
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    response.headers.set('X-WeFlix-Cache', 'HIT');
    return response;
  }

  const catalogObjects = await analyticsList(env.MEDIA, 'catalog/');
  const mediaCatalogObjects = catalogObjects.filter((item) => /^catalog\/(movie\/\d+|episode\/\d+\/\d+\/\d+)\.json$/.test(item.key));
  const manifests = await analyticsValues(env.MEDIA, mediaCatalogObjects);
  const movies = new Set();
  const series = new Set();
  for (let index = 0; index < manifests.length; index += 1) {
    const manifest = manifests[index];
    const key = mediaCatalogObjects[index]?.key || '';
    const lookupPath = key.replace(/^catalog\//, '').replace(/\.json$/, '');
    const minimumDuration = lookupPath.startsWith('movie/') ? 20 * 60 : 4 * 60;
    const duration = Number(manifest?.duration || 0);
    if (duration < minimumDuration || !manifest?.key) continue;
    if (lookupPath.startsWith('movie/')) {
      movies.add(Number(lookupPath.split('/')[1]));
    } else if (lookupPath.startsWith('episode/')) {
      series.add(Number(lookupPath.split('/')[1]));
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    movies: [...movies].filter(Number.isInteger).sort((left, right) => left - right),
    series: [...series].filter(Number.isInteger).sort((left, right) => left - right),
  };
  const response = json(payload, 200, { ...headers, 'Cache-Control': 'public, max-age=120, s-maxage=300' });
  response.headers.set('X-WeFlix-Cache', 'MISS');
  await caches.default.put(cacheKey, response.clone());
  return response;
};

const adminAnalytics = async (request, env, headers) => {
  if (!await adminCredentialsMatch(request, env)) return json({ error: 'Identifiants administrateur incorrects' }, 401, headers);
  const originMetricsPromise = env.MEDIA_ORIGIN_URL && env.MEDIA_ORIGIN_TOKEN
    ? fetch(`${String(env.MEDIA_ORIGIN_URL).replace(/\/$/, '')}/metrics`, { headers: { Authorization: `Bearer ${env.MEDIA_ORIGIN_TOKEN}` } })
      .then((response) => response.ok ? response.json() : null).catch(() => null)
    : Promise.resolve(null);
  const [userObjects, presenceObjects, watchingObjects, mediaObjects, eventObjects, catalogObjects, availabilityObjects, pendingObjects] = await Promise.all([
    analyticsList(env.MEDIA, 'analytics/users/'),
    analyticsList(env.MEDIA, 'analytics/presence/'),
    analyticsList(env.MEDIA, 'analytics/watching/'),
    analyticsList(env.MEDIA, 'analytics/media/'),
    analyticsList(env.MEDIA, 'analytics/events/', 500),
    analyticsList(env.MEDIA, 'catalog/'),
    analyticsList(env.MEDIA, 'catalog/availability/'),
    analyticsList(env.MEDIA, 'catalog/pending/'),
  ]);
  const mediaCatalogObjects = catalogObjects.filter((item) => /^catalog\/(movie\/\d+|episode\/\d+\/\d+\/\d+)\.json$/.test(item.key));
  const [users, presence, watching, media, events, catalogManifests, availability, pending] = await Promise.all([
    analyticsValues(env.MEDIA, userObjects),
    analyticsValues(env.MEDIA, presenceObjects),
    analyticsValues(env.MEDIA, watchingObjects),
    analyticsValues(env.MEDIA, mediaObjects),
    analyticsValues(env.MEDIA, eventObjects.slice(-500)),
    analyticsValues(env.MEDIA, mediaCatalogObjects),
    analyticsValues(env.MEDIA, availabilityObjects),
    analyticsValues(env.MEDIA, pendingObjects),
  ]);
  const now = Date.now();
  const isRecent = (value, seconds) => now - Date.parse(value.lastSeenAt || value.createdAt || 0) <= seconds * 1000;
  const online = presence.filter((item) => isRecent(item, 90)).sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  const currentlyWatching = watching.filter((item) => isRecent(item, 75)).sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  const catalogue = catalogManifests.map((manifest, index) => {
    const key = mediaCatalogObjects[index]?.key || '';
    const lookupPath = key.replace(/^catalog\//, '').replace(/\.json$/, '');
    const mediaType = lookupPath.startsWith('movie/') ? 'movie' : 'episode';
    const minimumDuration = mediaType === 'movie' ? 20 * 60 : 4 * 60;
    const duration = Number(manifest.duration || 0);
    return {
      lookupPath,
      mediaType,
      title: safeAnalyticsText(manifest.title || lookupPath, 200),
      duration,
      valid: duration >= minimumDuration,
      updatedAt: manifest.updatedAt || mediaCatalogObjects[index]?.uploaded,
      audioTracks: manifest.audioTracks || [],
      subtitleTracks: manifest.subtitleTracks || [],
    };
  });
  const validMovies = catalogue.filter((item) => item.mediaType === 'movie' && item.valid);
  const validEpisodes = catalogue.filter((item) => item.mediaType === 'episode' && item.valid);
  const seriesGroups = new Map();
  for (const episode of validEpisodes) {
    const seriesId = episode.lookupPath.split('/')[1];
    const current = seriesGroups.get(seriesId) || { mediaId: seriesId, title: episode.title.replace(/\s+S\d+E\d+.*$/i, ''), episodes: 0, lastUpdatedAt: null };
    current.episodes += 1;
    if (!current.lastUpdatedAt || Date.parse(episode.updatedAt || 0) > Date.parse(current.lastUpdatedAt || 0)) current.lastUpdatedAt = episode.updatedAt;
    seriesGroups.set(seriesId, current);
  }
  const unavailable = availability.filter((item) => item.status === 'unavailable');
  const pendingUnique = new Map(pending.map((item) => [`${item.mediaType}/${item.mediaId}`, item]));
  const trendMap = new Map();
  for (const event of events) {
    const day = String(event.createdAt || '').slice(0, 10);
    if (!day) continue;
    const point = trendMap.get(day) || { date: day, pageViews: 0, playbackStarts: 0, completions: 0 };
    if (event.type === 'page_view') point.pageViews += 1;
    if (event.type === 'playback_start') point.playbackStarts += 1;
    if (event.type === 'playback_complete') point.completions += 1;
    trendMap.set(day, point);
  }
  const totals = users.reduce((summary, item) => ({
    pageViews: summary.pageViews + Number(item.pageViews || 0),
    playbackStarts: summary.playbackStarts + Number(item.playbackStarts || 0),
    completions: summary.completions + Number(item.completions || 0),
    watchSeconds: summary.watchSeconds + Number(item.watchSeconds || 0),
  }), { pageViews: 0, playbackStarts: 0, completions: 0, watchSeconds: 0 });
  const origin = await originMetricsPromise;
  return json({
    generatedAt: new Date().toISOString(),
    totals: {
      ...totals,
      usersObserved: users.length,
      online: online.length,
      watching: currentlyWatching.length,
      movies: validMovies.length,
      series: seriesGroups.size,
      episodes: validEpisodes.length,
      pending: pendingUnique.size,
      unavailable: unavailable.length,
      invalidManifests: catalogue.filter((item) => !item.valid).length,
    },
    online: online.slice(0, 50),
    watching: currentlyWatching.slice(0, 50),
    topMedia: media.sort((a, b) => Number(b.views || 0) - Number(a.views || 0)).slice(0, 20),
    recentActivity: events.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 100),
    users: users.sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt)).slice(0, 500),
    trends: [...trendMap.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-14),
    catalogue: {
      movies: validMovies.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0)),
      series: [...seriesGroups.values()].sort((a, b) => a.title.localeCompare(b.title, 'fr')),
      episodes: validEpisodes.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0)),
      invalid: catalogue.filter((item) => !item.valid),
      pending: [...pendingUnique.values()].slice(0, 200),
      unavailable: unavailable.slice(0, 200),
    },
    system: { worker: 'online', r2: 'online', catalogueObjects: catalogue.length, generatedAt: new Date().toISOString(), origin },
  }, 200, headers);
};

const siteSettings = async (request, env, headers) => {
  const key = 'configuration/site-settings.json';
  if (request.method === 'GET') {
    const settings = await analyticsJson(env.MEDIA, key) || {};
    return json({
      destinationUrl: safeAnalyticsText(settings.destinationUrl, 500),
      buttonLabel: safeAnalyticsText(settings.buttonLabel, 60) || 'Accéder au site',
      configured: Boolean(settings.destinationUrl),
    }, 200, headers);
  }
  if (request.method !== 'PUT') return json({ error: 'Méthode non autorisée' }, 405, headers);
  if (!await adminCredentialsMatch(request, env)) return json({ error: 'Identifiants administrateur incorrects' }, 401, headers);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSON invalide' }, 400, headers); }
  try {
    const destination = new URL(String(body.destinationUrl || '').trim());
    if (!['http:', 'https:'].includes(destination.protocol)) throw new Error('URL HTTP ou HTTPS requise');
    const settings = {
      destinationUrl: destination.toString(),
      buttonLabel: safeAnalyticsText(body.buttonLabel, 60) || 'Accéder au site',
      updatedAt: new Date().toISOString(),
    };
    await analyticsPut(env.MEDIA, key, settings);
    return json({ ok: true, ...settings, configured: true }, 200, headers);
  } catch (error) {
    return json({ error: error.message || 'Configuration invalide' }, 400, headers);
  }
};

const serveMedia = async (request, env, url, key, headers) => {
  const signed = await hasValidSignature(url, env);
  if (!signed) {
    const user = await verifyFirebaseToken(request, env);
    if (!user) return json({ error: 'Authentification requise' }, 401, headers);
  }
  const rangeHeader = request.headers.get('Range');
  let range;
  if (rangeHeader) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (!match) return json({ error: 'Plage invalide' }, 416, headers);
    const offset = Number(match[1]);
    range = match[2] ? { offset, length: Number(match[2]) - offset + 1 } : { offset };
  }
  const object = await env.MEDIA.get(key, range ? { range } : undefined);
  if (!object) return json({ error: 'Média introuvable' }, 404, headers);
  const responseHeaders = new Headers(headers);
  object.writeHttpMetadata(responseHeaders);
  responseHeaders.set('ETag', object.httpEtag);
  responseHeaders.set('Accept-Ranges', 'bytes');
  responseHeaders.set('Cache-Control', 'private, max-age=300');
  if (range && object.range) {
    const start = object.range.offset;
    const end = start + object.range.length - 1;
    responseHeaders.set('Content-Range', `bytes ${start}-${end}/${object.size}`);
    responseHeaders.set('Content-Length', String(object.range.length));
  } else {
    responseHeaders.set('Content-Length', String(object.size));
  }
  if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers: responseHeaders });
  if (key.toLowerCase().endsWith('.m3u8')) {
    const playlist = await object.text();
    const baseDirectory = key.includes('/') ? key.slice(0, key.lastIndexOf('/') + 1) : '';
    const signReference = async (reference) => {
      if (!reference || /^(https?:|data:|skd:)/i.test(reference)) return reference;
      const resolved = new URL(reference, `https://r2.local/${baseDirectory}`).pathname.slice(1);
      return signedMediaUrl(new URL(request.url).origin, decodeURIComponent(resolved), env);
    };
    const rewritten = [];
    for (const line of playlist.split(/\r?\n/)) {
      if (line && !line.startsWith('#')) {
        rewritten.push(await signReference(line));
      } else if (line.includes('URI="')) {
        const match = /URI="([^"]+)"/.exec(line);
        rewritten.push(match ? line.replace(match[1], await signReference(match[1])) : line);
      } else {
        rewritten.push(line);
      }
    }
    responseHeaders.set('Content-Type', 'application/vnd.apple.mpegurl');
    responseHeaders.set('Cache-Control', 'private, no-store');
    responseHeaders.delete('Content-Length');
    return new Response(rewritten.join('\n'), { status: 200, headers: responseHeaders });
  }
  return new Response(object.body, { status: range ? 206 : 200, headers: responseHeaders });
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (url.pathname === '/health') return json({ ok: true, r2: Boolean(env.MEDIA) }, 200, headers);
    if (url.pathname.startsWith('/api/tmdb/') && request.method === 'GET') return proxyTmdb(request, env, url, headers);
    if (url.pathname === '/api/catalogue/available' && request.method === 'GET') return publicCatalogueAvailability(env, headers);
    if (url.pathname === '/api/turnstile/verify' && request.method === 'POST') return verifyTurnstile(request, env, headers);
    if (url.pathname === '/api/analytics/event' && request.method === 'POST') return analyticsEvent(request, env, headers);
    if (url.pathname === '/api/admin/session' && request.method === 'POST') return createAdminSession(request, env, headers);
    if (url.pathname === '/api/admin/analytics' && request.method === 'GET') return adminAnalytics(request, env, headers);
    if (url.pathname === '/api/site-settings' && ['GET', 'PUT'].includes(request.method)) return siteSettings(request, env, headers);
    if (url.pathname === '/api/media/request' && request.method === 'POST') return requestMedia(request, env, headers);
    if (url.pathname === '/api/media/session' && request.method === 'POST') return updateOriginSession(request, env, headers);
    if (url.pathname === '/api/media/requests/enqueue' && request.method === 'POST') return enqueueBridgeRequest(request, env, headers);
    if (url.pathname === '/api/media/requests/pull' && request.method === 'GET') return pullQueuedRequests(request, env, headers);
    if (url.pathname === '/api/media/requests/ack' && request.method === 'POST') return acknowledgeQueuedRequest(request, env, headers);
    if (url.pathname.startsWith('/api/media/status/') && request.method === 'GET') return provisionStatus(request, env, url, headers);
    if (url.pathname.startsWith('/api/media/lookup/') && request.method === 'GET') return lookupMedia(request, env, url, headers);
    if (url.pathname.startsWith('/media/') && ['GET', 'HEAD'].includes(request.method)) {
      const key = decodeURIComponent(url.pathname.slice('/media/'.length));
      if (!key || key.includes('..')) return json({ error: 'Chemin invalide' }, 400, headers);
      return serveMedia(request, env, url, key, headers);
    }
    return json({ error: 'Route inconnue' }, 404, headers);
  },
};
