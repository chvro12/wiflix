import { Readable, Transform } from 'node:stream';
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { access, mkdir, readFile, readdir, readlink, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const sendJson = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

const readJsonBody = (req, limit = 4096) => new Promise((resolveBody, reject) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > limit) reject(new Error('Requête trop volumineuse'));
  });
  req.on('end', () => {
    try { resolveBody(JSON.parse(body || '{}')); } catch { reject(new Error('JSON invalide')); }
  });
  req.on('error', reject);
});

const turnstileApi = (env) => ({
  name: 'weflix-turnstile',
  configureServer(server) {
    server.middlewares.use('/api/turnstile/verify', async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Méthode non autorisée' });
      if (!env.TURNSTILE_SECRET_KEY) return sendJson(res, 503, { error: 'Turnstile n’est pas configuré sur le serveur' });

      try {
        const { token } = await readJsonBody(req);
        if (!token || typeof token !== 'string' || token.length > 2048) {
          return sendJson(res, 400, { error: 'Validation anti-robot requise' });
        }
        const form = new FormData();
        form.set('secret', env.TURNSTILE_SECRET_KEY);
        form.set('response', token);
        const remoteIp = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        if (remoteIp) form.set('remoteip', remoteIp);
        const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST', body: form, signal: AbortSignal.timeout(8000),
        });
        const result = await response.json();
        if (!result.success) return sendJson(res, 403, { error: 'Validation anti-robot refusée' });
        return sendJson(res, 200, { success: true });
      } catch {
        return sendJson(res, 502, { error: 'Service anti-robot temporairement indisponible' });
      }
    });
  },
  configurePreviewServer(server) { this.configureServer(server); },
});

const siteSettingsApi = (env) => {
  const settingsPath = resolve('data/site-settings.json');
  const defaultSettings = {
    destinationUrl: env.REDIRECT_DESTINATION_URL || env.VITE_REDIRECT_DESTINATION_URL || '',
    buttonLabel: 'Accéder au site',
  };

  const readSettings = async () => {
    try {
      return { ...defaultSettings, ...JSON.parse(await readFile(settingsPath, 'utf8')) };
    } catch {
      return defaultSettings;
    }
  };

  const passwordsMatch = (received) => {
    const expected = env.ADMIN_PASSWORD || '';
    if (!expected || !received) return false;
    const expectedBuffer = Buffer.from(expected);
    const receivedBuffer = Buffer.from(received);
    return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
  };

  const parseBody = (req) => new Promise((resolveBody, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4096) reject(new Error('Requête trop volumineuse'));
    });
    req.on('end', () => {
      try { resolveBody(JSON.parse(body || '{}')); } catch { reject(new Error('JSON invalide')); }
    });
    req.on('error', reject);
  });

  const install = (server) => {
    server.middlewares.use('/api/site-settings', async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');

      if (req.method === 'GET') {
        const settings = await readSettings();
        return sendJson(res, 200, {
          destinationUrl: settings.destinationUrl,
          buttonLabel: settings.buttonLabel,
          configured: Boolean(settings.destinationUrl),
        });
      }

      if (req.method !== 'PUT') return sendJson(res, 405, { error: 'Méthode non autorisée' });
      if (!env.ADMIN_PASSWORD) return sendJson(res, 503, { error: 'ADMIN_PASSWORD n’est pas configuré sur le serveur' });
      if (!passwordsMatch(req.headers['x-admin-password'])) return sendJson(res, 401, { error: 'Mot de passe administrateur incorrect' });

      try {
        const body = await parseBody(req);
        const parsedUrl = new URL(String(body.destinationUrl || '').trim());
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Seules les URL HTTP et HTTPS sont acceptées');
        const settings = {
          destinationUrl: parsedUrl.toString(),
          buttonLabel: String(body.buttonLabel || 'Accéder au site').trim().slice(0, 60) || 'Accéder au site',
          updatedAt: new Date().toISOString(),
        };
        await mkdir(resolve('data'), { recursive: true });
        const temporaryPath = `${settingsPath}.${randomBytes(6).toString('hex')}.tmp`;
        await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
        await rename(temporaryPath, settingsPath);
        return sendJson(res, 200, { ok: true, ...settings });
      } catch (error) {
        return sendJson(res, 400, { error: error.message || 'Configuration invalide' });
      }
    });
  };

  return { name: 'weflix-site-settings', configureServer: install, configurePreviewServer: install };
};

const importerConfiguration = async (env) => {
  let stack = {};
  try {
    stack = Object.fromEntries((await readFile(resolve('infra/media-stack/.env'), 'utf8'))
      .split(/\r?\n/)
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1).replace(/^['"]|['"]$/g, '')];
      }));
  } catch { /* configuration via environnement uniquement */ }
  const user = env.R2_IMPORTER_USER || stack.R2_IMPORTER_USER || 'weflix';
  const password = env.R2_IMPORTER_PASSWORD || stack.R2_IMPORTER_PASSWORD;
  return {
    baseUrl: String(env.R2_IMPORTER_URL || 'http://127.0.0.1:8788').replace(/\/$/, ''),
    authorization: password ? `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` : '',
  };
};

const triggerProvision = async (env, payload) => {
  const importer = await importerConfiguration(env);
  if (!importer.authorization) throw new Error('Provisionneur média non configuré');
  const response = await fetch(`${importer.baseUrl}/provision`, {
    method: 'POST',
    headers: { Authorization: importer.authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Provisionneur média indisponible (${response.status})`);
  return response.json();
};

const mediaProvisionStatusApi = (env) => ({
  name: 'weflix-media-provision-status',
  configureServer(server) {
    server.middlewares.use('/api/media/status', async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Méthode non autorisée' });
      try {
        const lookupPath = decodeURIComponent(String(req.url || '').split('?')[0]).replace(/^\/+|\/+$/g, '');
        if (!lookupPath || !/^(movie\/\d+|episode\/\d+\/\d+\/\d+)$/.test(lookupPath)) return sendJson(res, 400, { error: 'Média invalide' });
        const importer = await importerConfiguration(env);
        const response = await fetch(`${importer.baseUrl}/status/${lookupPath}`, {
          headers: { Authorization: importer.authorization }, signal: AbortSignal.timeout(5000),
        });
        const result = await response.json().catch(() => ({}));
        return sendJson(res, response.status, result);
      } catch (error) {
        return sendJson(res, 502, { error: error.message || 'Statut média indisponible' });
      }
    });
  },
  configurePreviewServer(server) { this.configureServer(server); },
});

const seerrRequestApi = (env) => ({
  name: 'weflix-seerr-request',
  configureServer(server) {
    server.middlewares.use('/api/media/request', async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Méthode non autorisée' });

      try {
        let apiKey = env.SEERR_API_KEY;
        if (!apiKey) {
          const settings = JSON.parse(await readFile(resolve('infra/media-stack/config/seerr/settings.json'), 'utf8'));
          apiKey = settings.main?.apiKey;
        }
        if (!apiKey) return sendJson(res, 503, { error: 'Demandes automatiques non configurées' });
        const body = await readJsonBody(req);
        const mediaId = Number(body.mediaId);
        const mediaType = body.mediaType === 'tv' ? 'tv' : body.mediaType === 'movie' ? 'movie' : '';
        const season = Number(body.season);
        const episode = Number(body.episode);
        if (!Number.isInteger(mediaId) || mediaId <= 0 || !mediaType) {
          return sendJson(res, 400, { error: 'Média invalide' });
        }
        const payload = { mediaType, mediaId };
        if (mediaType === 'tv') payload.seasons = [Number.isInteger(season) && season > 0 ? season : 1];
        const provisionPayload = { mediaType, mediaId, season: payload.seasons?.[0], episode: Number.isInteger(episode) && episode > 0 ? episode : 1 };
        const seerrBaseUrl = String(env.SEERR_URL || 'http://127.0.0.1:5055').replace(/\/$/, '');
        const seerrHeaders = { 'Content-Type': 'application/json', 'X-Api-Key': apiKey };
        const existingResponse = await fetch(`${seerrBaseUrl}/api/v1/${mediaType}/${mediaId}`, { headers: seerrHeaders, signal: AbortSignal.timeout(10000) });
        if (existingResponse.ok) {
          const existing = await existingResponse.json();
          const activeRequests = (existing.mediaInfo?.requests || []).filter((request) => [1, 2].includes(Number(request.status)));
          const alreadyPending = mediaType === 'movie'
            ? activeRequests.length > 0
            : activeRequests.some((request) => (request.seasons || []).some((item) => Number(item.seasonNumber) === payload.seasons[0]));
          if (alreadyPending) {
            const provision = await triggerProvision(env, provisionPayload);
            return sendJson(res, 202, { requested: false, pending: true, requestId: activeRequests[0]?.id || null, provision: provision.provision });
          }
        }
        const response = await fetch(`${seerrBaseUrl}/api/v1/request`, {
          method: 'POST',
          headers: seerrHeaders,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
        });
        const result = await response.json().catch(() => ({}));
        // Seerr returns 409 when the title/season has already been requested. For
        // the player this is a pending request, not an error.
        if (response.ok || response.status === 409) {
          const provision = await triggerProvision(env, provisionPayload);
          return sendJson(res, 202, { requested: response.ok, pending: true, requestId: result.id || null, provision: provision.provision });
        }
        return sendJson(res, response.status, { error: result.message || 'Seerr a refusé la demande' });
      } catch (error) {
        return sendJson(res, 502, { error: error.message || 'Seerr temporairement indisponible' });
      }
    });
  },
  configurePreviewServer(server) { this.configureServer(server); },
});

const subtitleTimeShifter = (offset) => {
  let pending = '';
  const shift = (value) => {
    const parts = value.split(':').map(Number);
    const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
    const shifted = Math.max(0, seconds - offset);
    const hours = Math.floor(shifted / 3600);
    const minutes = Math.floor((shifted % 3600) / 60);
    const secs = (shifted % 60).toFixed(3).padStart(6, '0');
    return hours ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secs}` : `${String(minutes).padStart(2, '0')}:${secs}`;
  };
  const rewrite = (line) => line.replace(/\d{1,2}:\d{2}(?::\d{2})?\.\d{3}/g, shift);
  return new Transform({
    transform(chunk, encoding, done) {
      const lines = `${pending}${chunk.toString()}`.split('\n');
      pending = lines.pop() || '';
      done(null, `${lines.map(rewrite).join('\n')}\n`);
    },
    flush(done) { done(null, rewrite(pending)); },
  });
};

const jellyfinBridge = (env) => ({
  name: 'weflix-jellyfin-bridge',
  configureServer(server) {
    const baseUrl = env.JELLYFIN_URL || 'http://localhost:8096';
    const apiKey = env.JELLYFIN_API_KEY;
    const mediaPaths = new Map();
    const mediaDurations = new Map();
    const mediaTracks = new Map();
    const hlsSegmentDuration = 4;
    const dataRoot = resolve('infra/media-stack/data');
    const streamLibraryRoot = resolve('infra/media-stack/data/stream-library');
    const rcloneConfig = resolve('infra/media-stack/rclone-alldebrid.conf');
    const rcloneHttp = spawn('/opt/homebrew/bin/rclone', [
      'serve', 'http', 'AllDebrid:magnets', '--addr', '127.0.0.1:8686',
      '--config', rcloneConfig, '--read-only',
    ], { stdio: 'ignore' });
    server.httpServer?.once('close', () => rcloneHttp.kill('SIGTERM'));

    const resolvedHostMediaPath = async (jellyfinPath) => {
      if (!jellyfinPath?.startsWith('/data/')) return null;
      const isStreamPointer = jellyfinPath.startsWith('/data/library/') && jellyfinPath.endsWith('.strm');
      const hostPath = isStreamPointer
        ? resolve(streamLibraryRoot, jellyfinPath.slice('/data/library/'.length))
        : resolve(dataRoot, jellyfinPath.slice('/data/'.length));
      if (isStreamPointer) {
        const streamUrl = (await readFile(hostPath, 'utf8')).trim();
        if (!/^https?:\/\//i.test(streamUrl)) throw new Error('Pointeur de flux invalide');
        const validationUrl = streamUrl
          .replace(/^http:\/\/rclone-http:8686\//, 'http://127.0.0.1:8686/')
          .replace(/^http:\/\/r2-importer:8788\//, 'http://127.0.0.1:8788/');
        const response = await fetch(validationUrl, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error(`Source distante indisponible (${response.status})`);
        return streamUrl;
      }
      let target = hostPath;
      try {
        const linked = await readlink(hostPath);
        if (linked.startsWith('/data/alldebrid/')) {
          const remotePath = linked.slice('/data/alldebrid/'.length).split('/').map(encodeURIComponent).join('/');
          const response = await fetch(`http://127.0.0.1:8686/${remotePath}`, {
            method: 'HEAD', signal: AbortSignal.timeout(8000),
          });
          if (!response.ok) throw new Error(`Source distante indisponible (${response.status})`);
          return linked;
        }
        target = linked.startsWith('/data/')
          ? resolve(dataRoot, linked.slice('/data/'.length))
          : resolve(dirname(hostPath), linked);
      } catch { /* regular local file */ }
      await Promise.race([
        access(target),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Stockage média indisponible')), 2500)),
      ]);
      return target;
    };

    const jellyfinItemAvailable = async (item) => {
      if (!item?.Path) return false;
      if (!item.Path.startsWith('/data/')) return true;
      try { await resolvedHostMediaPath(item.Path); return true; } catch { return false; }
    };

    const hostStreamUrl = async (jellyfinPath) => {
      if (jellyfinPath?.startsWith('/data/library/') && jellyfinPath.endsWith('.strm')) {
        const pointerPath = resolve(streamLibraryRoot, jellyfinPath.slice('/data/library/'.length));
        return (await readFile(pointerPath, 'utf8')).trim()
          .replace(/^http:\/\/rclone-http:8686\//, 'http://127.0.0.1:8686/')
          .replace(/^http:\/\/r2-importer:8788\//, 'http://127.0.0.1:8788/');
      }
      const hostPath = resolve(dataRoot, jellyfinPath.slice('/data/'.length));
      let target = hostPath;
      try { target = await readlink(hostPath); } catch { return target; }
      if (target.startsWith('/data/alldebrid/')) {
        const relative = target.slice('/data/alldebrid/'.length).split('/').map(encodeURIComponent).join('/');
        return `http://127.0.0.1:8686/${relative}`;
      }
      return target;
    };

    const probeMedia = (sourceUrl, fallback) => new Promise((done) => {
      const probe = spawn('/opt/homebrew/bin/ffprobe', [
        '-v', 'error', '-show_format', '-show_streams', '-of', 'json', sourceUrl,
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      probe.stdout.on('data', (chunk) => { output += chunk; });
      probe.once('close', () => {
        try {
          const media = JSON.parse(output);
          const duration = Number.parseFloat(media.format?.duration);
          const tracks = (media.streams || []).filter((stream) => stream.codec_type === 'audio' || stream.codec_type === 'subtitle').map((stream) => ({
            index: stream.index,
            type: stream.codec_type,
            codec: stream.codec_name,
            language: stream.tags?.language || 'und',
            title: stream.tags?.title || '',
          }));
          done({ duration: Number.isFinite(duration) && duration > 0 ? duration : fallback, tracks });
        } catch { done({ duration: fallback, tracks: [] }); }
      });
      probe.once('error', () => done({ duration: fallback, tracks: [] }));
    });

    const playerPayload = async (item) => {
      mediaPaths.set(item.Id, item.Path);
      if (!mediaDurations.has(item.Id) && item.Path?.startsWith('/data/')) {
        const fallback = Math.max(60, Number(item.RunTimeTicks || 0) / 10_000_000 || 7200);
        const mediaInfo = await probeMedia(await hostStreamUrl(item.Path), fallback);
        mediaDurations.set(item.Id, mediaInfo.duration);
        mediaTracks.set(item.Id, mediaInfo.tracks);
      }
      const tracks = mediaTracks.get(item.Id) || [];
      const audioTracks = tracks.filter((track) => track.type === 'audio').sort((left, right) => {
        const preferred = (track) => /^(fre|fra|fr)$/i.test(track.language) || /fran[cç]ais|french|vff|vfq/i.test(track.title);
        return Number(preferred(right)) - Number(preferred(left));
      });
      return {
        available: true,
        id: item.Id,
        name: item.Name,
        duration: mediaDurations.get(item.Id) || Number(item.RunTimeTicks || 0) / 10_000_000 || 0,
        streamUrl: `/api/jellyfin/stream/${item.Id}`,
        audioTracks,
        subtitleTracks: tracks.filter((track) => track.type === 'subtitle').map((track) => ({ ...track, url: `/api/jellyfin/subtitles/${item.Id}/${track.index}.vtt` })),
      };
    };

    server.middlewares.use('/api/jellyfin', async (req, res) => {
      if (!apiKey) return sendJson(res, 503, { error: 'Jellyfin non configuré' });
      try {
        const requestUrl = new URL(req.url || '/', 'http://local');
        const parts = requestUrl.pathname.split('/').filter(Boolean);

        if (parts[0] === 'movie' && parts[1]) {
          // Préférer le pointeur .strm de Jellyfin : il passe par le serveur
          // HTTP interne et évite le démarrage plus lent d'un ffmpeg local.
          const jellyfinQuery = new URLSearchParams({ Recursive: 'true', IncludeItemTypes: 'Movie', Fields: 'ProviderIds,Path,RunTimeTicks' });
          const jellyfinResponse = await fetch(`${baseUrl}/Items?${jellyfinQuery}`, {
            headers: { 'X-Emby-Token': apiKey }, signal: AbortSignal.timeout(5000),
          });
          if (jellyfinResponse.ok) {
            const jellyfinItems = (await jellyfinResponse.json()).Items || [];
            const jellyfinItem = jellyfinItems.find((entry) => String(entry.ProviderIds?.Tmdb || entry.ProviderIds?.tmdb || '') === String(parts[1]));
            if (await jellyfinItemAvailable(jellyfinItem)) {
              return sendJson(res, 200, await playerPayload(jellyfinItem));
            }
          }
          localLookup: {
          const tmdbResponse = await fetch(`https://api.themoviedb.org/3/movie/${parts[1]}?api_key=${env.VITE_TMDB_API}&language=fr-FR`);
          if (tmdbResponse.ok) {
            const metadata = await tmdbResponse.json();
            const year = String(metadata.release_date || '').slice(0, 4);
            const normalize = (value) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
            const expected = normalize(`${metadata.title} ${year}`);
            const moviesRoot = resolve(dataRoot, 'library/movies');
            const folders = await readdir(moviesRoot, { withFileTypes: true });
            const folder = folders.find((entry) => entry.isDirectory() && normalize(entry.name) === expected);
            if (folder) {
              const folderPath = resolve(moviesRoot, folder.name);
              const files = await readdir(folderPath, { withFileTypes: true });
              const video = files.find((entry) => entry.isFile() || entry.isSymbolicLink());
              if (video) {
                const id = `tmdb-${parts[1]}`;
                const jellyfinPath = `/data/library/movies/${folder.name}/${video.name}`;
                mediaPaths.set(id, jellyfinPath);
                const hostPath = resolve(dataRoot, jellyfinPath.slice('/data/'.length));
                let target = hostPath;
                try { target = await readlink(hostPath); } catch { /* regular local file */ }
                try { await resolvedHostMediaPath(jellyfinPath); } catch { break localLookup; }
                const fallbackDuration = Math.max(60, Number(metadata.runtime || 120) * 60);
                if (target.startsWith('/data/alldebrid/')) {
                  const relative = target.slice('/data/alldebrid/'.length).split('/').map(encodeURIComponent).join('/');
                  // Do not block the first frame on a full remote ffprobe. The
                  // title becomes playable immediately while tracks are filled
                  // asynchronously for the next visit.
                  mediaDurations.set(id, fallbackDuration);
                  probeMedia(`http://127.0.0.1:8686/${relative}`, fallbackDuration).then((mediaInfo) => {
                    mediaDurations.set(id, mediaInfo.duration);
                    mediaTracks.set(id, mediaInfo.tracks);
                  });
                } else {
                  mediaDurations.set(id, fallbackDuration);
                }
                const tracks = mediaTracks.get(id) || [];
                return sendJson(res, 200, {
                  available: true, id, name: metadata.title, duration: mediaDurations.get(id), streamUrl: `/api/jellyfin/stream/${id}`,
                  audioTracks: tracks.filter((track) => track.type === 'audio'),
                  subtitleTracks: tracks.filter((track) => track.type === 'subtitle').map((track) => ({ ...track, url: `/api/jellyfin/subtitles/${id}/${track.index}.vtt` })),
                });
              }
            }
          }
          }

          const query = new URLSearchParams({ Recursive: 'true', IncludeItemTypes: 'Movie', Fields: 'ProviderIds,Path,RunTimeTicks' });
          const response = await fetch(`${baseUrl}/Items?${query}`, { headers: { 'X-Emby-Token': apiKey }, signal: AbortSignal.timeout(3000) });
          const items = (await response.json()).Items || [];
          const item = items.find((entry) => String(entry.ProviderIds?.Tmdb || entry.ProviderIds?.tmdb || '') === String(parts[1]));
          const availableItem = await jellyfinItemAvailable(item) ? item : null;
          if (availableItem?.Path) mediaPaths.set(availableItem.Id, availableItem.Path);
          else if (item?.Id) mediaPaths.delete(item.Id);
          return sendJson(res, 200, availableItem ? await playerPayload(availableItem) : { available: false });
        }

        if (parts[0] === 'episode' && parts.length >= 4) {
          const [, tmdbId, season, episode] = parts;
          // The direct pointer is usable as soon as it is written; Jellyfin can
          // finish its library scan in the background without delaying playback.
          const tvRoot = resolve(streamLibraryRoot, 'tv');
          const seriesFolders = await readdir(tvRoot, { withFileTypes: true }).catch(() => []);
          for (const folder of seriesFolders.filter((entry) => entry.isDirectory())) {
            const folderPath = resolve(tvRoot, folder.name);
            const nfo = await readFile(resolve(folderPath, 'tvshow.nfo'), 'utf8').catch(() => '');
            if (!nfo.includes(`<tmdbid>${tmdbId}</tmdbid>`)) continue;
            const seasonPath = resolve(folderPath, `Season ${String(Number(season)).padStart(2, '0')}`);
            const files = await readdir(seasonPath, { withFileTypes: true }).catch(() => []);
            const token = `S${String(Number(season)).padStart(2, '0')}E${String(Number(episode)).padStart(2, '0')}`;
            const pointer = files.find((entry) => entry.isFile() && entry.name.includes(token) && entry.name.endsWith('.strm'));
            if (!pointer) continue;
            const directItem = {
              Id: `tmdb-episode-${tmdbId}-${season}-${episode}`,
              Name: token,
              Path: `/data/library/tv/${folder.name}/Season ${String(Number(season)).padStart(2, '0')}/${pointer.name}`,
            };
            if (await jellyfinItemAvailable(directItem)) return sendJson(res, 200, await playerPayload(directItem));
          }
          const query = new URLSearchParams({ Recursive: 'true', IncludeItemTypes: 'Series', Fields: 'ProviderIds' });
          const seriesResponse = await fetch(`${baseUrl}/Items?${query}`, { headers: { 'X-Emby-Token': apiKey } });
          const seriesItems = (await seriesResponse.json()).Items || [];
          const matchingSeries = seriesItems.filter((entry) => String(entry.ProviderIds?.Tmdb || entry.ProviderIds?.tmdb || '') === String(tmdbId));
          if (!matchingSeries.length) return sendJson(res, 200, { available: false });
          const episodeQuery = new URLSearchParams({ Season: season, Fields: 'ProviderIds,Path,RunTimeTicks' });
          let item = null;
          for (const series of matchingSeries) {
            const episodesResponse = await fetch(`${baseUrl}/Shows/${series.Id}/Episodes?${episodeQuery}`, { headers: { 'X-Emby-Token': apiKey } });
            const candidates = ((await episodesResponse.json()).Items || []).filter((entry) => Number(entry.IndexNumber) === Number(episode));
            for (const candidate of candidates) {
              if (await jellyfinItemAvailable(candidate)) { item = candidate; break; }
            }
            if (item) break;
          }
          const availableItem = item;
          if (availableItem?.Path) mediaPaths.set(availableItem.Id, availableItem.Path);
          else if (item?.Id) mediaPaths.delete(item.Id);
          return sendJson(res, 200, availableItem ? await playerPayload(availableItem) : { available: false });
        }

        if (parts[0] === 'hls' && parts[1] && parts[2] === 'index.m3u8') {
          const duration = mediaDurations.get(parts[1]);
          if (!duration) return sendJson(res, 404, { error: 'Média inconnu' });
          const segmentDuration = hlsSegmentDuration;
          const count = Math.ceil(duration / segmentDuration);
          const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${segmentDuration}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
          for (let index = 0; index < count; index += 1) {
            const length = Math.min(segmentDuration, duration - index * segmentDuration);
            lines.push(`#EXTINF:${length.toFixed(3)},`, `/api/jellyfin/hls/${parts[1]}/seg-${index}.ts`);
          }
          lines.push('#EXT-X-ENDLIST');
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          res.setHeader('Cache-Control', 'no-store');
          return res.end(`${lines.join('\n')}\n`);
        }

        if (parts[0] === 'hls' && parts[1] && /^seg-\d+\.ts$/.test(parts[2] || '')) {
          const jellyfinPath = mediaPaths.get(parts[1]);
          if (!jellyfinPath) return sendJson(res, 404, { error: 'Média inconnu' });
          const hostPath = resolve(dataRoot, jellyfinPath.slice('/data/'.length));
          let target = hostPath;
          try { target = await readlink(hostPath); } catch { /* regular local file */ }
          if (!target.startsWith('/data/alldebrid/')) return sendJson(res, 409, { error: 'Source HLS non distante' });

          const index = Number(parts[2].match(/\d+/)[0]);
          const relative = target.slice('/data/alldebrid/'.length).split('/').map(encodeURIComponent).join('/');
          const sourceUrl = `http://127.0.0.1:8686/${relative}`;
          const ffmpeg = spawn('/opt/homebrew/bin/ffmpeg', [
            '-hide_banner', '-loglevel', 'error', '-ss', String(index * hlsSegmentDuration), '-i', sourceUrl,
            '-t', String(hlsSegmentDuration), '-map', '0:v:0', '-map', '0:a:0?', '-sn',
            '-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb', '-c:a', 'aac', '-b:a', '192k',
            '-muxdelay', '0', '-f', 'mpegts', 'pipe:1',
          ], { stdio: ['ignore', 'pipe', 'pipe'] });
          res.statusCode = 200;
          res.setHeader('Content-Type', 'video/mp2t');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          ffmpeg.stdout.pipe(res);
          req.on('close', () => ffmpeg.kill('SIGTERM'));
          return;
        }

        if (parts[0] === 'subtitles' && parts[1] && /^\d+\.vtt$/.test(parts[2] || '')) {
          const jellyfinPath = mediaPaths.get(parts[1]);
          const trackIndex = Number.parseInt(parts[2], 10);
          const track = (mediaTracks.get(parts[1]) || []).find((entry) => entry.type === 'subtitle' && entry.index === trackIndex);
          if (!jellyfinPath || !track) return sendJson(res, 404, { error: 'Sous-titres inconnus' });
          const sourceUrl = await hostStreamUrl(jellyfinPath);
          const start = Math.max(0, Number(requestUrl.searchParams.get('start')) || 0);
          const ffmpeg = spawn('/opt/homebrew/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(start), '-i', sourceUrl, '-map', `0:${trackIndex}`, '-f', 'webvtt', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          ffmpeg.stdout.pipe(subtitleTimeShifter(start)).pipe(res);
          req.on('close', () => ffmpeg.kill('SIGTERM'));
          return;
        }

        if (parts[0] === 'stream' && parts[1]) {
          const jellyfinPath = mediaPaths.get(parts[1]);
          if (jellyfinPath?.startsWith('/data/')) {
            const hostPath = resolve(dataRoot, jellyfinPath.slice('/data/'.length));
            if (jellyfinPath.startsWith('/data/library/') && jellyfinPath.endsWith('.strm')) {
              const sourceUrl = await hostStreamUrl(jellyfinPath);
              const start = Math.max(0, Number(requestUrl.searchParams.get('start')) || 0);
              const fastStart = Math.max(0, start - 12);
              const preciseStart = start - fastStart;
              const availableAudio = (mediaTracks.get(parts[1]) || []).filter((track) => track.type === 'audio');
              const requestedAudio = Number(requestUrl.searchParams.get('audio'));
              const frenchAudio = availableAudio.find((track) => /^(fre|fra|fr)$/i.test(track.language) || /fran[cç]ais|french|vff|vfq/i.test(track.title));
              const audioIndex = availableAudio.some((track) => track.index === requestedAudio)
                ? requestedAudio : frenchAudio?.index ?? availableAudio[0]?.index;
              const ffmpeg = spawn('/opt/homebrew/bin/ffmpeg', [
                '-hide_banner', '-loglevel', 'error', '-ss', String(fastStart), '-i', sourceUrl,
                ...(preciseStart > 0 ? ['-ss', String(preciseStart)] : []),
                '-map', '0:v:0', ...(audioIndex === undefined ? ['-map', '0:a:0?'] : ['-map', `0:${audioIndex}`]), '-sn',
                '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
                '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
                '-f', 'mp4', 'pipe:1',
              ], { stdio: ['ignore', 'pipe', 'pipe'] });
              res.statusCode = 200;
              res.setHeader('Content-Type', 'video/mp4');
              res.setHeader('Cache-Control', 'no-store');
              ffmpeg.stdout.pipe(res);
              const stop = () => { if (!ffmpeg.killed) ffmpeg.kill('SIGTERM'); };
              req.on('close', stop);
              ffmpeg.on('error', stop);
              return;
            }
            let target = hostPath;
            try { target = await readlink(hostPath); } catch { /* regular local file */ }

            if (target.startsWith('/data/alldebrid/')) {
              const relative = target.slice('/data/alldebrid/'.length).split('/').map(encodeURIComponent).join('/');
              const sourceUrl = `http://127.0.0.1:8686/${relative}`;
              const start = Math.max(0, Number(requestUrl.searchParams.get('start')) || 0);
              const fastStart = Math.max(0, start - 12);
              const preciseStart = start - fastStart;
              const availableAudio = (mediaTracks.get(parts[1]) || []).filter((track) => track.type === 'audio');
              const requestedAudio = Number(requestUrl.searchParams.get('audio'));
              const audioIndex = availableAudio.some((track) => track.index === requestedAudio) ? requestedAudio : availableAudio[0]?.index;
              const ffmpeg = spawn('/opt/homebrew/bin/ffmpeg', [
                '-hide_banner', '-loglevel', 'error', '-ss', String(fastStart), '-i', sourceUrl,
                ...(preciseStart > 0 ? ['-ss', String(preciseStart)] : []),
                '-map', '0:v:0', ...(audioIndex === undefined ? ['-map', '0:a:0?'] : ['-map', `0:${audioIndex}`]), '-sn',
                '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
                '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
                '-f', 'mp4', 'pipe:1',
              ], { stdio: ['pipe', 'pipe', 'pipe'] });

              res.statusCode = 200;
              res.setHeader('Content-Type', 'video/mp4');
              res.setHeader('Cache-Control', 'no-store');
              ffmpeg.stdout.pipe(res);

              const stop = () => ffmpeg.kill('SIGTERM');
              req.on('close', stop);
              ffmpeg.on('error', stop);
              return;
            }
          }

          const headers = { 'X-Emby-Token': apiKey };
          if (req.headers.range) headers.Range = req.headers.range;
          const upstream = await fetch(`${baseUrl}/Videos/${parts[1]}/stream?Static=true`, { headers });
          res.statusCode = upstream.status;
          for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
            const value = upstream.headers.get(header);
            if (value) res.setHeader(header, value);
          }
          if (!upstream.body) return res.end();
          return Readable.fromWeb(upstream.body).pipe(res);
        }
        return sendJson(res, 404, { error: 'Route inconnue' });
      } catch (error) {
        return sendJson(res, 502, { error: error.message || 'Erreur Jellyfin' });
      }
    });
  },
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return { plugins: [react(), turnstileApi(env), siteSettingsApi(env), seerrRequestApi(env), mediaProvisionStatusApi(env), jellyfinBridge(env)], server: { host: '127.0.0.1', port: 5173 } };
});
