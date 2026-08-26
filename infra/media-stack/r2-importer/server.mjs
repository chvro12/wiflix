import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';

const required = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT', 'R2_BUCKET', 'R2_IMPORTER_PASSWORD'];
for (const name of required) if (!process.env[name]) throw new Error(`${name} manque.`);

const acceleratorStatePath = process.env.ACCELERATOR_STATE_PATH || '/state/accelerator.json';
const acceleratorState = { completed: [], errors: [], queues: [], history: [] };
let stateWrite = Promise.resolve();

const loadAcceleratorState = async () => {
  try {
    const saved = JSON.parse(await readFile(acceleratorStatePath, 'utf8'));
    for (const key of Object.keys(acceleratorState)) {
      acceleratorState[key] = Array.isArray(saved[key]) ? saved[key].slice(-5000) : [];
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`État accélérateur illisible: ${error.message}`);
  }
};

const rememberAccelerator = async (bucket, value) => {
  if (!acceleratorState[bucket].includes(value)) acceleratorState[bucket].push(value);
  acceleratorState[bucket] = acceleratorState[bucket].slice(-5000);
  stateWrite = stateWrite.then(async () => {
    await mkdir(dirname(acceleratorStatePath), { recursive: true });
    const temporaryPath = `${acceleratorStatePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(acceleratorState, null, 2)}\n`);
    await rename(temporaryPath, acceleratorStatePath);
  }).catch((error) => console.error(`Sauvegarde état accélérateur: ${error.message}`));
  await stateWrite;
};

const rcloneEnv = {
  ...process.env,
  RCLONE_CONFIG_WEFLIXR2_TYPE: 's3',
  RCLONE_CONFIG_WEFLIXR2_PROVIDER: 'Cloudflare',
  RCLONE_CONFIG_WEFLIXR2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
  RCLONE_CONFIG_WEFLIXR2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  RCLONE_CONFIG_WEFLIXR2_ENDPOINT: process.env.R2_ENDPOINT,
};

const activeBackgroundProcesses = new Map();

const run = (command, args, options = {}) => new Promise((done, reject) => {
  const { timeoutMs = 0, onSpawn, ...spawnOptions } = options;
  const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'], ...spawnOptions });
  if (onSpawn) onSpawn(child);
  const timer = timeoutMs > 0 ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
  child.once('error', reject);
  child.once('close', (code) => {
    if (timer) clearTimeout(timer);
    code === 0 ? done() : reject(new Error(`${command} a quitté avec le code ${code}.`));
  });
});

const capture = (command, args, timeoutMs = 120_000, options = {}) => new Promise((done, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code) => {
    clearTimeout(timer);
    code === 0 ? done(stdout) : reject(new Error(`${command} a échoué : ${stderr.trim() || `code ${code}`}`));
  });
});

const captureBuffer = (command, args, timeoutMs = 120_000, options = {}) => new Promise((done, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const chunks = [];
  let stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code) => {
    clearTimeout(timer);
    code === 0 ? done(Buffer.concat(chunks)) : reject(new Error(`${command} a échoué : ${stderr.trim() || `code ${code}`}`));
  });
});

const selectAudioStreams = (streams, sourcePath) => {
  const isFrench = (stream) => {
    const language = String(stream.tags?.language || '').toLowerCase();
    const title = String(stream.tags?.title || '').toLowerCase();
    return ['fre', 'fra', 'fr', 'fr-fr', 'fr-ca'].includes(language)
      || /fran[cç]ais|french|truefrench|qu[eé]b[eé]cois|canadien/.test(title);
  };
  if (!streams.length) throw new Error(`Aucune piste audio détectée : ${sourcePath}`);
  const maximumTracks = Math.max(1, Math.min(4, Number(process.env.R2_MAX_AUDIO_TRACKS) || 1));
  const selected = [...streams].sort((left, right) => Number(isFrench(right)) - Number(isFrench(left))).slice(0, maximumTracks);
  if (!selected.some(isFrench)) console.warn(`Aucune piste française, conservation des pistes disponibles : ${sourcePath}`);
  return selected.map((stream, index) => ({
    sourceIndex: stream.index,
    index,
    codec: String(stream.codec_name || '').toLowerCase(),
    channels: Number(stream.channels) || 0,
    language: isFrench(stream) ? 'fre' : String(stream.tags?.language || 'und').toLowerCase(),
    title: isFrench(stream) ? 'Français' : String(stream.tags?.title || stream.tags?.language || `Audio ${index + 1}`),
    default: index === 0,
  }));
};

const inspectMedia = async (sourcePath, timeoutMs = 20_000) => {
  const raw = await capture('ffprobe', [
    '-v', 'error', '-show_entries',
    'stream=index,codec_type,codec_name,width,height,channels:stream_tags=language,title:format=duration,format_name',
    '-of', 'json', sourcePath,
  ], timeoutMs);
  const probe = JSON.parse(raw);
  const video = (probe.streams || []).find((stream) => stream.codec_type === 'video') || {};
  return {
    profile: {
      videoCodec: String(video.codec_name || '').toLowerCase(),
      width: Number(video.width) || 0,
      height: Number(video.height) || 0,
      duration: Math.max(0, Number(probe.format?.duration) || 0),
      formatName: String(probe.format?.format_name || '').toLowerCase(),
    },
    tracks: selectAudioStreams((probe.streams || []).filter((stream) => stream.codec_type === 'audio'), sourcePath),
  };
};

const audioStreams = async (sourcePath) => (await inspectMedia(sourcePath)).tracks;

const mediaProfile = async (sourcePath) => {
  try {
    const raw = await capture('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=codec_name,width,height:format=duration', '-of', 'json', sourcePath,
    ], 15_000);
    const probe = JSON.parse(raw);
    const stream = probe.streams?.[0] || {};
    return {
      videoCodec: String(stream.codec_name || ''),
      width: Number(stream.width) || 0,
      height: Number(stream.height) || 0,
      duration: Math.max(0, Number(probe.format?.duration) || 0),
    };
  } catch {
    return { videoCodec: '', width: 0, height: 0, duration: 0 };
  }
};

const streamLibraryRoot = process.env.STREAM_LIBRARY_ROOT || '/stream-library';

const createStreamPointer = async (sourcePath) => {
  if (!sourcePath?.startsWith('/data/library/')) return false;
  let target;
  try { target = await readlink(sourcePath); } catch { return false; }
  if (!target.startsWith('/data/alldebrid/')) return false;
  const remotePath = target.slice('/data/alldebrid/'.length).split('/').map(encodeURIComponent).join('/');
  const libraryPath = sourcePath.slice('/data/library/'.length).replace(/\.[^/.]+$/, '.strm');
  const outputPath = join(streamLibraryRoot, libraryPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `http://rclone-http:8686/${remotePath}\n`);
  return true;
};

const syncStreamLibrary = async () => {
  let created = 0;
  const visit = async (directory) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isSymbolicLink() && await createStreamPointer(entryPath)) created += 1;
    }
  };
  await visit('/data/library');
  if (created > 0 && process.env.JELLYFIN_API_KEY) {
    const response = await fetch(`${process.env.JELLYFIN_URL || 'http://jellyfin:8096'}/Library/Refresh`, {
      method: 'POST', headers: { 'X-Emby-Token': process.env.JELLYFIN_API_KEY }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Rafraîchissement Jellyfin a répondu ${response.status}.`);
  }
  console.log(`Bibliothèque .strm synchronisée (${created} pointeur(s)).`);
};

const seerrApiKey = async () => {
  if (process.env.SEERR_API_KEY) return process.env.SEERR_API_KEY;
  const settings = JSON.parse(await readFile('/seerr/settings.json', 'utf8'));
  const key = settings.main?.apiKey;
  if (!key) throw new Error('Clé API Seerr absente.');
  return key;
};

const forwardQueuedRequests = async () => {
  const edgeUrl = String(process.env.EDGE_API_URL || 'https://weflix-edge.weflix-tsamba.workers.dev').replace(/\/$/, '');
  const authorization = `Bearer ${process.env.R2_IMPORTER_PASSWORD}`;
  const pullResponse = await fetch(`${edgeUrl}/api/media/requests/pull`, {
    headers: { Authorization: authorization }, signal: AbortSignal.timeout(15_000),
  });
  if (!pullResponse.ok) throw new Error(`Worker pull a répondu ${pullResponse.status}.`);
  const entries = (await pullResponse.json()).requests || [];
  if (!entries.length) return 0;
  console.log(`File R2: ${entries.length} demande(s) en attente.`);
  const apiKey = await seerrApiKey();
  const baseUrl = String(process.env.SEERR_URL || 'http://seerr:5055').replace(/\/$/, '');
  for (const entry of entries) {
    try {
      const body = entry.body;
      const payload = { mediaType: body.mediaType, mediaId: Number(body.mediaId) };
      if (payload.mediaType === 'tv') payload.seasons = Array.isArray(body.seasons) ? body.seasons : [1];
      const headers = { 'Content-Type': 'application/json', 'X-Api-Key': apiKey };
      const existingResponse = await fetch(`${baseUrl}/api/v1/${payload.mediaType}/${payload.mediaId}`, {
        headers, signal: AbortSignal.timeout(10_000),
      });
      let alreadyPending = false;
      if (existingResponse.ok) {
        const existing = await existingResponse.json();
        const active = (existing.mediaInfo?.requests || []).filter((item) => [1, 2].includes(Number(item.status)));
        alreadyPending = payload.mediaType === 'movie'
          ? active.length > 0
          : active.some((item) => (item.seasons || []).some((season) => payload.seasons.includes(Number(season.seasonNumber))));
      }
      if (!alreadyPending) {
        const response = await fetch(`${baseUrl}/api/v1/request`, {
          method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok && response.status !== 409) throw new Error(`Seerr a répondu ${response.status}.`);
      }
      startProvision({
        ...body,
        season: Number(body.season ?? body.seasons?.[0]) || 1,
        episode: Number(body.episode) || 1,
      });
      const acknowledge = await fetch(`${edgeUrl}/api/media/requests/ack`, {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: entry.key }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!acknowledge.ok) throw new Error(`Worker ack a répondu ${acknowledge.status}.`);
      console.log(`Demande R2 transmise à Seerr: ${payload.mediaType}/${payload.mediaId}`);
    } catch (error) {
      console.error(`Demande R2 conservée pour nouvel essai (${entry.key}): ${error.message}`);
    }
  }
  return entries.length;
};

const syncApprovedSeerrRequests = async () => {
  const apiKey = await seerrApiKey();
  const baseUrl = String(process.env.SEERR_URL || 'http://seerr:5055').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/api/v1/request?take=100&skip=0&sort=added`, {
    headers: { 'X-Api-Key': apiKey }, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Seerr liste des demandes a répondu ${response.status}.`);
  const results = (await response.json()).results || [];
  let started = 0;
  for (const request of results) {
    if (Number(request.status) !== 2 || !request.media?.tmdbId || started >= 10) continue;
    if (request.type === 'movie') {
      const lookupPath = `movie/${request.media.tmdbId}`;
      if (!provisions.has(lookupPath)) { startProvision({ mediaType: 'movie', mediaId: request.media.tmdbId }); started += 1; }
      continue;
    }
    if (request.type === 'tv') {
      for (const season of request.seasons || []) {
        const seasonNumber = Number(season.seasonNumber);
        const lookupPath = `episode/${request.media.tmdbId}/${seasonNumber}/1`;
        if (seasonNumber > 0 && !provisions.has(lookupPath) && started < 10) {
          startProvision({ mediaType: 'tv', mediaId: request.media.tmdbId, season: seasonNumber, episode: 1 });
          started += 1;
        }
      }
    }
  }
  if (started) console.log(`Seerr: ${started} nouvelle(s) demande(s) confiée(s) au provisionneur direct.`);
  return started;
};

const authenticated = (request) => {
  const expected = Buffer.from(`${process.env.R2_IMPORTER_USER || 'weflix'}:${process.env.R2_IMPORTER_PASSWORD}`);
  const value = request.headers.authorization || '';
  if (!value.startsWith('Basic ')) return false;
  let received;
  try { received = Buffer.from(value.slice(6), 'base64'); } catch { return false; }
  return received.length === expected.length && timingSafeEqual(received, expected);
};

const readBody = (request) => new Promise((done, reject) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1024 * 1024) reject(new Error('Webhook trop volumineux.'));
  });
  request.on('end', () => { try { done(JSON.parse(body || '{}')); } catch { reject(new Error('JSON invalide.')); } });
  request.on('error', reject);
});

const tmdbFromTvdb = async (tvdbId) => {
  const apiKey = process.env.VITE_TMDB_API;
  if (!apiKey) throw new Error('VITE_TMDB_API manque pour convertir TVDB vers TMDB.');
  const response = await fetch(`https://api.themoviedb.org/3/find/${encodeURIComponent(tvdbId)}?api_key=${encodeURIComponent(apiKey)}&external_source=tvdb_id`);
  if (!response.ok) throw new Error(`TMDB find a répondu ${response.status}.`);
  const data = await response.json();
  const id = data.tv_results?.[0]?.id;
  if (!id) throw new Error(`Aucune série TMDB pour TVDB ${tvdbId}.`);
  return id;
};

const arrJson = async (baseUrl, apiKey, path) => {
  const response = await fetch(`${baseUrl}${path}`, { headers: { 'X-Api-Key': apiKey }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${baseUrl}${path} a répondu ${response.status}.`);
  return response.json();
};

const cometReleaseTitle = (stream) => {
  if (stream?.behaviorHints?.filename) return String(stream.behaviorHints.filename);
  const firstLine = String(stream?.description || '').split('\n')[0].replace(/^📄\s*/u, '').trim();
  return firstLine || String(stream?.name || 'Source Comet');
};

const cometReleases = async ({ mediaType, imdbId, season, episode }) => {
  const baseUrl = String(process.env.COMET_URL || '').replace(/\/$/, '');
  if (!baseUrl || !/^tt\d+$/i.test(String(imdbId || ''))) return [];
  const identifier = mediaType === 'series'
    ? `${imdbId}:${Math.max(1, Number(season) || 1)}:${Math.max(1, Number(episode) || 1)}`
    : imdbId;
  try {
    const response = await fetch(`${baseUrl}/stream/${mediaType}/${encodeURIComponent(identifier)}.json`, {
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return (payload.streams || []).filter((stream) => /^[a-f0-9]{40}$/i.test(String(stream.infoHash || ''))).map((stream) => {
      const title = cometReleaseTitle(stream);
      const description = String(stream.description || '');
      const seeders = Number(/👤\s*(\d+)/u.exec(description)?.[1]) || 0;
      const quality = /\b(2160p|4k)\b/i.test(`${stream.name} ${description}`) ? '2160p'
        : /\b1080p\b/i.test(`${stream.name} ${description}`) ? '1080p'
          : /\b720p\b/i.test(`${stream.name} ${description}`) ? '720p' : 'Unknown';
      return {
        title,
        guid: `magnet:?xt=urn:btih:${String(stream.infoHash).toLowerCase()}&dn=${encodeURIComponent(title)}`,
        size: Number(stream.behaviorHints?.videoSize) || 0,
        seeders,
        quality: { quality: { name: quality } },
        indexer: 'Comet',
        _trustedIdentity: true,
      };
    });
  } catch (error) {
    console.warn(`Recherche Comet ${mediaType}/${identifier}: ${error.message}`);
    return [];
  }
};

const mergedReleases = (...groups) => {
  const unique = new Map();
  for (const release of groups.flat()) {
    const hash = /urn:btih:([a-f0-9]{40})/i.exec(String(release.guid || ''))?.[1]?.toLowerCase();
    const key = hash || `${release.title}|${release.size}`;
    if (!unique.has(key)) unique.set(key, release);
  }
  return [...unique.values()];
};

// Direct provisioning deliberately uses stable IDs all the way through:
// TMDB -> Arr item -> magnet -> AllDebrid magnet/file index -> Jellyfin .strm.
// No filename matching or NFS mount is involved in the critical path.
const provisionStatePath = process.env.PROVISION_STATE_PATH || '/state/provisions.json';
const multiSourceEnabled = process.env.MULTI_SOURCE_ENABLED !== 'false';
const multiSourceMaximum = Math.max(1, Math.min(5, Number(process.env.MULTI_SOURCE_MAX) || 3));
const provisions = new Map();
const activeProvisions = new Set();
const unlockedLinks = new Map();
let provisionStateWrite = Promise.resolve();
let provisionStatusPublish = Promise.resolve();
const provisionPublishTimers = new Map();
const provisionPublishPending = new Map();

const persistProvisionSnapshot = () => {
  provisionStateWrite = provisionStateWrite.then(async () => {
    await mkdir(dirname(provisionStatePath), { recursive: true });
    const temporaryPath = `${provisionStatePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(Object.fromEntries(provisions), null, 2)}\n`);
    await rename(temporaryPath, provisionStatePath);
  }).catch((error) => console.error(`Sauvegarde état provisionneur: ${error.message}`));
  return provisionStateWrite;
};

const normalizedMediaIdentity = (value) => String(value || '').normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ').trim();

const sourceMatchesExpectedTitle = (sourceTitle, expectedTitles) => {
  const source = normalizedMediaIdentity(sourceTitle);
  return (expectedTitles || []).some((title) => {
    const expected = normalizedMediaIdentity(title).replace(/\bs\d{1,2}e\d{1,3}\b.*$/, '').trim();
    if (expected.length < 3) return false;
    return source === expected || source.startsWith(`${expected} `) || source.includes(` ${expected} `);
  });
};

const sourceMatchesExpectedYear = (sourceTitle, expectedYears = []) => {
  const allowedYears = new Set(expectedYears.map(Number).filter(Number.isInteger));
  if (!allowedYears.size) return true;
  const sourceYears = [...String(sourceTitle || '').matchAll(/\b(19\d{2}|20\d{2})\b/g)]
    .map((match) => Number(match[1]));
  // Some releases omit the year. That is not enough to reject an otherwise
  // exact title match, but an explicit conflicting year is always fatal.
  return !sourceYears.length || sourceYears.some((year) => allowedYears.has(year));
};

const loadProvisionState = async () => {
  try {
    const saved = JSON.parse(await readFile(provisionStatePath, 'utf8'));
    let changed = false;
    for (const [key, value] of Object.entries(saved)) {
      // Remove the former fixed 75-day delay. Released films must now be
      // checked against real HD sources instead of an arbitrary calendar rule.
      if (value?.error === 'La sortie est trop récente pour garantir une véritable version HD.') {
        value.retryAt = new Date().toISOString();
        changed = true;
      }
      if (/Aucune source (?:1080p\/HD|vidéo) exploitable|Aucune source correspondant exactement/i.test(String(value?.error || ''))) {
        value.retryAt = new Date().toISOString();
        value.message = 'Aucun fichier n’est disponible pour le moment. Nous réessaierons automatiquement plus tard.';
        changed = true;
      }
      if (/timeout|aborted/i.test(String(value?.error || ''))) {
        value.retryAt = new Date().toISOString();
        value.message = 'La recherche prend plus de temps que prévu. Une nouvelle tentative sera lancée dans quelques minutes.';
        changed = true;
      }
      if (/aucune véritable source HD exploitable/i.test(String(value?.message || ''))) {
        value.message = 'On élargit la recherche à la meilleure qualité disponible…';
        changed = true;
      }
      if (key.startsWith('episode/2685/') && value?.status === 'ready' && /\breacher\b/i.test(String(value?.sourceTitle || ''))) {
        value.status = 'retrying';
        value.stage = 'retry';
        value.progress = 15;
        value.etaSeconds = null;
        value.etaKind = null;
        value.retryAt = new Date().toISOString();
        value.message = 'Le fichier associé ne correspondait pas à cette série. Une nouvelle recherche correcte est lancée.';
        value.error = 'Association de série invalide détectée et neutralisée.';
        delete value.magnetId;
        delete value.fileIndex;
        delete value.fileName;
        delete value.sourceTitle;
        delete value.sourceSize;
        delete value.readyAt;
        changed = true;
      }
      if (key.startsWith('episode/2685/') && value?.status !== 'ready' && value?.readyAt) {
        delete value.readyAt;
        changed = true;
      }
      // A container restart interrupts in-flight jobs. Recover them instead of
      // leaving the UI forever on a stale "searching" or "downloading" state.
      if (!['ready', 'retrying'].includes(value?.status)) {
        value.status = 'retrying';
        value.stage = 'retry';
        value.retryAt = new Date().toISOString();
        value.message = 'On reprend automatiquement la préparation…';
        changed = true;
      }
      // Temporary origin sessions live only in the current process. After a
      // restart, never advertise their former state as still playable.
      if (['live_ready', 'live_failed'].includes(value.availabilityState)) {
        value.availabilityState = value.status === 'ready' ? 'source_ready' : 'failed';
        delete value.liveAttemptId;
        delete value.liveReadyAt;
        delete value.liveCompletedAt;
        changed = true;
      }
      if (value.status === 'retrying' && value.availabilityState === 'preparing') {
        value.availabilityState = 'failed';
        changed = true;
      }
      if (!value.availabilityState) {
        value.availabilityState = value.status === 'ready' ? (value.r2ReadyAt ? 'r2_ready' : 'source_ready') : value.status === 'retrying' ? 'failed' : 'preparing';
        changed = true;
      }
      provisions.set(key, value);
    }
    if (changed) await writeFile(provisionStatePath, `${JSON.stringify(Object.fromEntries(provisions), null, 2)}\n`);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`État du provisionneur illisible: ${error.message}`);
  }
};

const publicSource = (candidate, activeSourceId = '') => ({
  id: candidate.id,
  label: candidate.label,
  language: candidate.language,
  quality: candidate.quality,
  videoCodec: candidate.videoCodec,
  audioCodec: candidate.audioCodec || 'unknown',
  cached: candidate.cached !== false,
  state: candidate.state || 'validated',
  selected: candidate.id === activeSourceId,
});

const publicProvision = (value) => {
  if (!value) return null;
  const safe = { ...value };
  for (const field of ['fileLink', 'sourceCandidates', 'magnetId', 'fileIndex', 'fileName', 'sourceHash', 'sourceTitle', 'sourceSize', 'provider']) delete safe[field];
  return {
    ...safe,
    sources: (value.sourceCandidates || []).map((candidate) => publicSource(candidate, value.activeSourceId)),
  };
};

const publishProvisionStatus = async (lookupPath, value) => {
  const directory = await mkdtemp(join(tmpdir(), 'weflix-status-'));
  try {
    const file = join(directory, 'status.json');
    await writeFile(file, `${JSON.stringify(publicProvision(value), null, 2)}\n`);
    await run('rclone', ['copyto', file, `WEFLIXR2:${process.env.R2_BUCKET}/requests/status/${lookupPath}.json`], { env: rcloneEnv, timeoutMs: 30_000 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const estimatedProvisionEta = (lookupPath, status, progress, startedAt) => {
  if (!['queued', 'waiting-arr', 'searching', 'selecting', 'downloading', 'publishing'].includes(status)) return null;
  const percent = Math.max(1, Math.min(95, Number(progress) || 1));
  const elapsed = Math.max(0, (Date.now() - Date.parse(startedAt || new Date().toISOString())) / 1000);
  // Films already cached are normally ready in a few seconds. Episodes can
  // take longer because several sources are inspected for a French audio
  // track. Once enough progress has been observed, actual elapsed time also
  // contributes to the estimate so slow providers extend it automatically.
  const baseline = lookupPath.startsWith('episode/') ? 120 : 30;
  const baselineRemaining = baseline * ((100 - percent) / 100);
  const measuredRemaining = elapsed >= 3 ? elapsed * ((100 - percent) / percent) : 0;
  return Math.max(3, Math.min(20 * 60, Math.ceil(Math.max(baselineRemaining, measuredRemaining))));
};

const updateProvision = async (lookupPath, patch) => {
  const previous = provisions.get(lookupPath) || { lookupPath, startedAt: new Date().toISOString() };
  const value = { ...previous, ...patch, lookupPath, updatedAt: new Date().toISOString() };
  if (['ready', 'retrying'].includes(value.status)) value.etaKind = null;
  if ((!Number.isFinite(Number(value.etaSeconds)) || value.etaSeconds === null) && !value.etaKind) {
    const estimate = estimatedProvisionEta(lookupPath, value.status, value.progress, value.startedAt);
    if (estimate !== null) {
      value.etaSeconds = estimate;
      value.etaKind = 'estimated';
    }
  }
  provisions.set(lookupPath, value);
  await persistProvisionSnapshot();
  provisionPublishPending.set(lookupPath, value);
  if (!provisionPublishTimers.has(lookupPath)) {
    const immediate = previous.status !== value.status || previous.stage !== value.stage;
    const timer = setTimeout(() => {
      provisionPublishTimers.delete(lookupPath);
      const pending = provisionPublishPending.get(lookupPath);
      provisionPublishPending.delete(lookupPath);
      if (!pending) return;
      provisionStatusPublish = provisionStatusPublish
        .then(() => publishProvisionStatus(lookupPath, pending))
        .catch((error) => console.error(`Publication statut ${lookupPath}: ${error.message}`));
    }, immediate ? 50 : 2_000);
    provisionPublishTimers.set(lookupPath, timer);
  }
  return value;
};

const allDebridRequest = async (path, fields = {}) => {
  const apiKey = process.env.ALLDEBRID_API_KEY;
  if (!apiKey) throw new Error('ALLDEBRID_API_KEY manque.');
  const response = await fetch(`https://api.alldebrid.com${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: (() => {
      const body = new URLSearchParams();
      for (const [key, value] of Object.entries(fields)) {
        if (Array.isArray(value)) value.forEach((entry) => body.append(key, String(entry)));
        else body.append(key, String(value));
      }
      return body;
    })(),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.status !== 'success') throw new Error(result.error?.message || `AllDebrid ${path} a répondu ${response.status}.`);
  return result.data;
};

const uploadMagnet = async (magnet) => {
  const data = await allDebridRequest('/v4/magnet/upload', { 'magnets[]': magnet });
  const uploaded = data.magnets?.[0];
  if (!uploaded?.id || uploaded.error) throw new Error(uploaded?.error?.message || 'AllDebrid a refusé la source.');
  return uploaded;
};

const uploadMagnets = async (magnets) => {
  if (!magnets.length) return [];
  const data = await allDebridRequest('/v4/magnet/upload', { 'magnets[]': magnets });
  return Array.isArray(data.magnets) ? data.magnets : [];
};

const deleteMagnet = async (id) => {
  try { await allDebridRequest('/v4/magnet/delete', { id }); } catch { /* nettoyage opportuniste */ }
};

const magnetStatus = async (id) => {
  const data = await allDebridRequest('/v4.1/magnet/status', { id });
  const magnet = Array.isArray(data.magnets) ? data.magnets[0] : data.magnets;
  if (!magnet || Number(magnet.statusCode) !== 4) return magnet;
  const filesData = await allDebridRequest('/v4.1/magnet/files', { 'id[]': id });
  const filesMagnet = Array.isArray(filesData.magnets) ? filesData.magnets[0] : filesData.magnets;
  return { ...magnet, files: filesMagnet?.files || [] };
};

const realDebridRequest = async (path, { method = 'GET', fields } = {}) => {
  const apiKey = process.env.REAL_DEBRID_API_KEY;
  if (!apiKey) throw new Error('REAL_DEBRID_API_KEY manque.');
  const response = await fetch(`https://api.real-debrid.com/rest/1.0${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: fields ? new URLSearchParams(Object.entries(fields).map(([key, value]) => [key, String(value)])) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  const result = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(result?.error || `Real-Debrid ${path} a répondu ${response.status}.`);
  return result;
};

const deleteRealDebridTorrent = async (id) => {
  try { await realDebridRequest(`/torrents/delete/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch { /* nettoyage opportuniste */ }
};

const realDebridVideoFiles = (torrent) => {
  const selectedFiles = (torrent?.files || []).filter((file) => Number(file.selected) === 1);
  return selectedFiles
    .map((file, index) => ({
      name: basename(String(file.path || '')),
      path: String(file.path || ''),
      size: Number(file.bytes) || 0,
      link: torrent.links?.[index],
      fileIndex: Number(file.id),
    }))
    .filter((file) => file.link && /\.(mkv|mp4|m4v|avi|mov|ts|m2ts|webm)$/i.test(file.name) && file.size > 100 * 1024 ** 2);
};

const tryRealDebridCachedSource = async (lookupPath, candidates, fileMatcher, silent = false) => {
  if (!process.env.REAL_DEBRID_API_KEY) return null;
  for (const [index, release] of candidates.slice(0, 10).entries()) {
    if (!silent) await updateProvision(lookupPath, {
      status: 'selecting', stage: 'source', progress: 45 + Math.min(10, index),
      etaSeconds: null, etaKind: null, message: 'On vérifie une source de secours…',
    });
    let torrent;
    try {
      torrent = await realDebridRequest('/torrents/addMagnet', { method: 'POST', fields: { magnet: release.guid } });
      await realDebridRequest(`/torrents/selectFiles/${encodeURIComponent(torrent.id)}`, { method: 'POST', fields: { files: 'all' } });
      let info;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        info = await realDebridRequest(`/torrents/info/${encodeURIComponent(torrent.id)}`);
        if (info.status === 'downloaded' || ['error', 'virus', 'dead', 'magnet_error'].includes(info.status)) break;
        await sleep(1000);
      }
      if (info?.status !== 'downloaded') { await deleteRealDebridTorrent(torrent.id); continue; }
      const files = realDebridVideoFiles(info);
      const selected = fileMatcher(files) || (lookupPath.startsWith('movie/') ? files.sort((left, right) => right.size - left.size)[0] : null);
      if (!selected) { await deleteRealDebridTorrent(torrent.id); continue; }
      return { provider: 'realdebrid', release, uploaded: torrent, status: info, selected, files };
    } catch {
      if (torrent?.id) await deleteRealDebridTorrent(torrent.id);
    }
  }
  return null;
};

const flattenMagnetFiles = (nodes, prefix = '') => {
  const files = [];
  for (const node of nodes || []) {
    const path = prefix ? `${prefix}/${node.n || ''}` : String(node.n || '');
    if (node.l) files.push({ name: node.n || basename(path), path, size: Number(node.s) || 0, link: node.l });
    if (Array.isArray(node.e)) files.push(...flattenMagnetFiles(node.e, path));
  }
  return files;
};

const videoFiles = (magnet) => flattenMagnetFiles(magnet?.files)
  .filter((file) => /\.(mkv|mp4|m4v|avi|mov|ts|m2ts|webm)$/i.test(file.name) && file.size > 100 * 1024 ** 2)
  .map((file, fileIndex) => ({ ...file, fileIndex }));

const sourceHasFrenchAudio = async (file) => {
  try {
    const unlocked = await allDebridRequest('/v4/link/unlock', { link: file.link });
    if (!unlocked?.link) return null;
    const raw = await capture('ffprobe', [
      '-v', 'error', '-select_streams', 'a', '-show_entries',
      'stream_tags=language,title', '-of', 'json', unlocked.link,
    ], 8_000);
    const audioStreams = JSON.parse(raw).streams || [];
    const taggedStreams = audioStreams.filter((stream) => String(stream.tags?.language || stream.tags?.title || '').trim());
    // Older French AVI releases often contain no language metadata at all.
    // Unknown is different from explicitly non-French: retain the strong VFF
    // release label instead of incorrectly rejecting the source.
    if (!taggedStreams.length) return null;
    return taggedStreams.some((stream) => {
      const language = String(stream.tags?.language || '').toLowerCase();
      const title = String(stream.tags?.title || '').toLowerCase();
      return ['fre', 'fra', 'fr', 'fr-fr', 'fr-ca'].includes(language)
        || /fran[cç]ais|french|truefrench|qu[eé]b[eé]cois|canadien/.test(title);
    });
  } catch {
    return null;
  }
};

const episodeNumbersFromFile = (file) => {
  const path = String(file?.path || file?.name || '');
  const standard = /s(\d{1,3})[ ._-]*e(\d{1,3})/i.exec(path);
  if (standard) return { season: Number(standard[1]), episode: Number(standard[2]) };
  const folderSeasons = [...path.matchAll(/(?:season|saison)[ ._-]*(\d{1,3})/gi)];
  // Multi-season packs often mention "Saison 1-2-3-4" in the root folder.
  // The nearest (last) season folder is the authoritative one for files named
  // only "01.avi", "02.avi", etc.
  const folderSeason = folderSeasons.at(-1);
  const numberedFile = /^0*(\d{1,3})(?:\D|$)/.exec(basename(path));
  if (folderSeason && numberedFile) return { season: Number(folderSeason[1]), episode: Number(numberedFile[1]) };
  return null;
};

const safeName = (value) => String(value || 'Media').normalize('NFKD').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'Media';
const xml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

const releaseQualityRank = (release) => {
  const label = `${release.title || ''} ${release.quality?.quality?.name || ''}`;
  if (/\b1080[pi]\b/i.test(label)) return 3;
  if (/\b720[pi]\b/i.test(label)) return 2;
  if (/\b(576|540|480)[pi]\b|\b(dvd|sd|webrip|web[- .]?dl|hdtv)\b/i.test(label)) return 1;
  return 0;
};

const releaseLanguageRank = (title) => {
  const label = String(title || '');
  const confirmedFrenchLabel = /\b(vf|vff|vfq|french|truefrench)\b/i.test(label);
  const multilingualLabel = /\bmulti\b/i.test(label);
  const subtitlesOnly = /\bvostfr\b/i.test(label) && !confirmedFrenchLabel && !multilingualLabel;
  return confirmedFrenchLabel ? 3 : multilingualLabel ? 2 : subtitlesOnly ? 0 : 1;
};

const releaseCodecRank = (title) => {
  const label = String(title || '');
  if (/\b(x264|h[ ._-]*264|avc)\b/i.test(label)) return 2;
  if (/\b(x265|h[ ._-]*265|hevc|av1)\b/i.test(label)) return 0;
  return 1;
};

const rankedReleases = (releases, isSeries = false, preferFastPreload = false) => releases
  .filter((release) => String(release.guid || '').startsWith('magnet:'))
  .filter((release) => !/\b(cam|hdcam|telesync|telecine|workprint|screener|pre)\b|hq[ ._-]*pre|remux|2160p|4k/i.test(`${release.title} ${release.quality?.quality?.name || ''}`))
  .map((release) => {
    const rejections = release.rejections || [];
    // Radarr/Sonarr can reject a release only because it is below the active
    // quality profile. That warning must remain usable as our last-resort
    // fallback; only identity/parsing errors are unsafe to grab.
    const fatal = rejections.some((reason) => /unable to parse|unknown movie|wrong movie|unknown series|wrong series|wrong year/i.test(reason));
    const title = String(release.title || '');
    // Language is deliberately the first sorting key: a lower-resolution VF
    // must always beat a higher-resolution release without French audio.
    // Quality, size and seeders only decide between releases in the same
    // language tier.
    const languageRank = releaseLanguageRank(title);
    // Within the same language tier, prefer AVC/H.264 because it can usually
    // be repackaged directly into HLS without a full CPU transcode.
    const codecRank = releaseCodecRank(title);
    // Comet aggregates several exact-IMDb sources. Within the same language
    // tier, prefer its VF/MULTi candidates before Arr/Prowlarr results. A
    // non-French Comet result can never outrank a French result because the
    // language tier remains the first and largest sorting key.
    const cometFrenchPriority = release.indexer === 'Comet' && languageRank >= 2 ? 1 : 0;
    const preferredSize = preferFastPreload
      ? Number(release.size) >= 400 * 1024 ** 2 && Number(release.size) <= 2.5 * 1024 ** 3
      : Number(release.size) >= 1.5 * 1024 ** 3 && Number(release.size) <= 5 * 1024 ** 3;
    const detectedQualityRank = releaseQualityRank(release);
    // Background publications target 720p. A compact 720p AVC source avoids
    // downloading and decoding surplus pixels, while interactive requests keep
    // the normal 1080p preference.
    const qualityRank = preferFastPreload && detectedQualityRank === 2
      ? 3
      : preferFastPreload && detectedQualityRank === 3 ? 2 : detectedQualityRank;
    const customFormatScore = Math.max(-1000, Math.min(1000, Number(release.customFormatScore) || 0));
    const plausibleMovieSize = isSeries || (Number(release.size) >= 300 * 1024 ** 2 && Number(release.size) <= 8 * 1024 ** 3);
    return {
      ...release,
      usable: !fatal && plausibleMovieSize,
      languageRank,
      codecRank,
      qualityRank,
      rank: languageRank * 1_000_000_000
        + codecRank * 100_000_000
        + cometFrenchPriority * 10_000_000
        + qualityRank * 1_000_000
        + customFormatScore * 100
        + (preferredSize ? 100_000 : 0)
        + Math.min(Number(release.seeders || 0), 999),
    };
  })
  .filter((release) => release.usable)
  .sort((left, right) => right.rank - left.rank || Number(left.size) - Number(right.size));

const releaseInfoHash = (release) => /urn:btih:([a-f0-9]{40})/i.exec(String(release?.guid || ''))?.[1]?.toLowerCase() || '';

const withAlternatives = (selection, alternatives = [selection]) => ({
  ...selection,
  alternatives: [...new Map(alternatives.filter(Boolean).map((item) => [
    `${item.provider}:${item.uploaded?.id}:${item.selected?.fileIndex}`,
    item,
  ])).values()].slice(0, multiSourceEnabled ? multiSourceMaximum : 1),
});

const selectAllDebridSource = async (lookupPath, releases, fileMatcher, expectedTitles = [], expectedYears = [], preferredSourceHash = '', silent = false, preferFastPreload = false, cachedOnly = false) => {
  const preferredHash = /^[a-f0-9]{40}$/i.test(preferredSourceHash) ? preferredSourceHash.toLowerCase() : '';
  const rankedCandidates = rankedReleases(releases, lookupPath.startsWith('episode/'), preferFastPreload)
    .filter((release) => release._trustedIdentity || !expectedTitles.length || sourceMatchesExpectedTitle(release.title, expectedTitles))
    .filter((release) => sourceMatchesExpectedYear(release.title, expectedYears))
    .sort((left, right) => Number(releaseInfoHash(right) === preferredHash) - Number(releaseInfoHash(left) === preferredHash));
  const frenchCandidates = rankedCandidates.filter((release) => release.languageRank >= 2);
  const candidates = (frenchCandidates.length ? frenchCandidates : rankedCandidates)
    .slice(0, cachedOnly ? 60 : 25);
  if (!candidates.length) {
    const error = new Error('Aucune source correspondant exactement au média n’a été trouvée.');
    error.publicMessage = 'Aucun fichier n’est disponible pour le moment. Nous réessaierons automatiquement plus tard.';
    error.retryAt = new Date(Date.now() + 30 * 60_000).toISOString();
    throw error;
  }
  const isSeries = lookupPath.startsWith('episode/');
  let fallbackRelease = null;
  const validated = [];
  let checkedSeriesSources = 0;
  const targetSourceCount = cachedOnly && multiSourceEnabled ? multiSourceMaximum : 1;

  if (cachedOnly) {
    for (let offset = 0; offset < candidates.length && validated.length < targetSourceCount; offset += 20) {
      const releases = candidates.slice(offset, offset + 20);
      let uploadedBatch = [];
      try { uploadedBatch = await uploadMagnets(releases.map((release) => release.guid)); }
      catch (error) { console.warn(`Vérification groupée AllDebrid ${lookupPath}: ${error.message}`); }
      for (const [index, release] of releases.entries()) {
        const uploaded = uploadedBatch[index];
        if (!uploaded?.id || uploaded.error) continue;
        if (!uploaded.ready) {
          await deleteMagnet(uploaded.id);
          continue;
        }
        try {
          const status = await magnetStatus(uploaded.id);
          const files = videoFiles(status);
          const selected = fileMatcher(files) || (isSeries ? null : files.sort((left, right) => right.size - left.size)[0]);
          if (!selected) { await deleteMagnet(uploaded.id); continue; }
          const candidate = { provider: 'alldebrid', release, uploaded, status, selected, files };
          if (isSeries) {
            const hasFrenchAudio = await sourceHasFrenchAudio(selected);
            if (hasFrenchAudio === false) { await deleteMagnet(uploaded.id); continue; }
            candidate.audioVerifiedFrench = hasFrenchAudio;
          }
          validated.push(candidate);
          if (validated.length >= targetSourceCount) break;
        } catch {
          await deleteMagnet(uploaded.id);
        }
      }
    }
    if (validated.length) return withAlternatives(validated[0], validated);
    const realDebridSelection = await tryRealDebridCachedSource(lookupPath, candidates, fileMatcher, silent);
    return realDebridSelection ? withAlternatives(realDebridSelection) : null;
  }

  for (const [index, release] of candidates.entries()) {
    if (!isSeries && validated.length >= targetSourceCount) break;
    if (isSeries && cachedOnly && validated.length >= targetSourceCount) break;
    if (isSeries && !cachedOnly && validated.some((candidate) => candidate.audioVerifiedFrench !== false)) break;
    if (isSeries && !cachedOnly && checkedSeriesSources >= 3 && validated.length) break;
    if (!silent) await updateProvision(lookupPath, { status: 'selecting', stage: 'source', progress: 30 + Math.min(25, index * 2), etaSeconds: null, etaKind: null, message: `On vérifie la meilleure version (${index + 1}/${candidates.length})…` });
    let uploaded;
    try { uploaded = await uploadMagnet(release.guid); } catch { continue; }
    if (!fallbackRelease) fallbackRelease = release;
    if (!uploaded.ready) { await deleteMagnet(uploaded.id); continue; }
    const status = await magnetStatus(uploaded.id);
    const files = videoFiles(status);
    const selected = fileMatcher(files) || (lookupPath.startsWith('movie/') ? files.sort((left, right) => right.size - left.size)[0] : null);
    if (!selected) { await deleteMagnet(uploaded.id); continue; }
    const candidate = { provider: 'alldebrid', release, uploaded, status, selected, files };
    if (isSeries && checkedSeriesSources < 3) {
      checkedSeriesSources += 1;
      const hasFrenchAudio = await sourceHasFrenchAudio(selected);
      if (hasFrenchAudio === false) {
        validated.push({ ...candidate, audioVerifiedFrench: false });
        continue;
      }
      validated.push({ ...candidate, audioVerifiedFrench: hasFrenchAudio });
      continue;
    }
    validated.push(candidate);
  }

  if (validated.length) {
    validated.sort((left, right) => Number(right.audioVerifiedFrench !== false) - Number(left.audioVerifiedFrench !== false));
    return withAlternatives(validated[0], validated);
  }

  // AllDebrid remains the primary provider. Real-Debrid is queried only when
  // no suitable AllDebrid source was found (including the French-audio
  // preference), avoiding needless duplicate transfers while benefiting from
  // its independent cache.
  const realDebridSelection = await tryRealDebridCachedSource(lookupPath, candidates, fileMatcher, silent);
  if (realDebridSelection) return withAlternatives(realDebridSelection);
  // Coverage fallback: if nothing was cached, let AllDebrid fetch the best
  // candidate and expose its real byte-based ETA instead of failing forever.
  const topLanguageRank = candidates[0]?.languageRank;
  const downloadCandidates = candidates
    .filter((release) => release.languageRank === topLanguageRank)
    .sort((left, right) => Number(right.seeders || 0) - Number(left.seeders || 0) || Number(left.size || 0) - Number(right.size || 0))
    .slice(0, 4);
  if (fallbackRelease && !downloadCandidates.some((release) => releaseInfoHash(release) === releaseInfoHash(fallbackRelease))) {
    downloadCandidates.unshift(fallbackRelease);
  }
  let lastDownloadError = null;
  for (const [sourceIndex, release] of downloadCandidates.slice(0, 4).entries()) {
    let uploaded;
    try { uploaded = await uploadMagnet(release.guid); }
    catch (error) { lastDownloadError = error; continue; }
    const finalCandidate = sourceIndex === Math.min(3, downloadCandidates.length - 1);
    const maximumAttempts = finalCandidate ? 48 : 6;
    let previousDownloaded = 0;
    let stagnantChecks = 0;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const status = await magnetStatus(uploaded.id);
      const total = Math.max(1, Number(status.size) || Number(uploaded.size) || Number(release.size) || 1);
      const downloaded = Number(status.downloaded) || 0;
      const speed = Number(status.downloadSpeed) || 0;
      const ratio = Math.min(1, downloaded / total);
      const etaSeconds = speed > 0 ? Math.ceil((total - downloaded) / speed) : null;
      stagnantChecks = downloaded > previousDownloaded ? 0 : stagnantChecks + 1;
      previousDownloaded = downloaded;
      if (!silent) await updateProvision(lookupPath, {
        status: 'downloading', stage: 'debrid', progress: 55 + Math.round(ratio * 25),
        etaSeconds, etaKind: speed > 0 ? 'calculated' : null,
        message: sourceIndex > 0 ? `On essaie une source plus rapide (${sourceIndex + 1}/${Math.min(4, downloadCandidates.length)})…`
          : speed > 0 ? 'Votre séance arrive…' : 'On termine de préparer la meilleure version…',
      });
      if (Number(status.statusCode) === 4) {
        const files = videoFiles(status);
        const selected = fileMatcher(files) || (lookupPath.startsWith('movie/') ? files.sort((left, right) => right.size - left.size)[0] : null);
        if (!selected) { lastDownloadError = new Error('La source ne contient aucun fichier vidéo exploitable.'); break; }
        return withAlternatives({ provider: 'alldebrid', release, uploaded, status, selected, files });
      }
      if (Number(status.statusCode) >= 5) {
        lastDownloadError = new Error(`AllDebrid: ${status.status || 'échec de préparation'}.`);
        break;
      }
      const tooSlow = attempt >= 5 && ratio < 0.05 && (speed < 2 * 1024 ** 2 || stagnantChecks >= 3);
      if (!finalCandidate && tooSlow) {
        lastDownloadError = new Error('Source trop lente, remplacement automatique.');
        break;
      }
      await sleep(5000);
    }
    await deleteMagnet(uploaded.id);
  }
  const error = new Error(lastDownloadError?.message || 'Aucune source n’a atteint une vitesse suffisante.');
  error.publicMessage = 'Aucune source rapide n’est disponible pour le moment. Nous réessaierons automatiquement plus tard.';
  error.retryAt = new Date(Date.now() + 10 * 60_000).toISOString();
  throw error;
};

const cometPrimaryEnabled = !['0', 'false', 'off', 'no'].includes(String(process.env.COMET_PRIMARY || 'true').toLowerCase());

const selectPrimaryMediaSource = async ({
  lookupPath, cometParams, loadFallbackReleases, fileMatcher, expectedTitles,
  expectedYears = [], preferredSourceHash = '', preferFastPreload = false,
}) => {
  const comet = await cometReleases(cometParams);
  if (cometPrimaryEnabled && comet.length) {
    try {
      const cachedSelection = await selectAllDebridSource(
        lookupPath, comet, fileMatcher, expectedTitles, expectedYears,
        preferredSourceHash, false, preferFastPreload, true,
      );
      if (cachedSelection) return { ...cachedSelection, discoveryProvider: 'comet' };
    } catch (error) {
      console.warn(`Comet principal ${lookupPath}: ${error.message}`);
    }
  }

  const fallback = await loadFallbackReleases();
  const selection = await selectAllDebridSource(
    lookupPath, mergedReleases(comet, fallback), fileMatcher, expectedTitles,
    expectedYears, preferredSourceHash, false, preferFastPreload,
  );
  return { ...selection, discoveryProvider: selection.release?.indexer === 'Comet' ? 'comet' : 'arr' };
};

let jellyfinRefreshTimer;
const refreshJellyfin = async () => {
  clearTimeout(jellyfinRefreshTimer);
  jellyfinRefreshTimer = setTimeout(async () => {
    try {
      const response = await fetch(`${process.env.JELLYFIN_URL || 'http://jellyfin:8096'}/Library/Refresh`, {
        method: 'POST', headers: { 'X-Emby-Token': process.env.JELLYFIN_API_KEY }, signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Rafraîchissement de la bibliothèque: ${response.status}.`);
    } catch (error) {
      console.error(`Mise à jour de la bibliothèque: ${error.message}`);
    }
  }, 2500);
};

const sourceCandidateId = (lookupPath, provider, sourceHash, fileIndex) => createHmac(
  'sha256', process.env.MEDIA_ORIGIN_SIGNING_KEY || process.env.R2_IMPORTER_PASSWORD,
).update(`${lookupPath}:${provider}:${sourceHash}:${fileIndex}`).digest('base64url').slice(0, 16);

const sourceCandidateFromSelection = (lookupPath, selection, selectedOverride = null) => {
  const selected = selectedOverride || selection.selected;
  const title = String(selection.release?.title || '');
  const sourceHash = releaseInfoHash(selection.release);
  const language = releaseLanguageRank(title) >= 3 ? 'VF' : releaseLanguageRank(title) === 2 ? 'MULTi' : 'Autre';
  const quality = releaseQualityRank(selection.release) >= 3 ? '1080p' : releaseQualityRank(selection.release) === 2 ? '720p' : 'SD';
  const videoCodec = releaseCodecRank(title) === 2 ? 'H.264' : /\b(av1)\b/i.test(title) ? 'AV1' : /\b(x265|h[ ._-]*265|hevc)\b/i.test(title) ? 'HEVC' : 'Inconnu';
  return {
    id: sourceCandidateId(lookupPath, selection.provider, sourceHash, selected.fileIndex),
    provider: selection.provider,
    magnetId: selection.uploaded.id,
    fileIndex: selected.fileIndex,
    fileName: selected.name,
    sourceTitle: selection.release.title,
    sourceHash,
    sourceSize: selected.size,
    language, quality, videoCodec,
    audioCodec: 'unknown', cached: true, score: Number(selection.release.rank) || 0,
    label: `${language} · ${quality} · ${videoCodec}`,
    state: 'validated', validatedAt: new Date().toISOString(),
  };
};

const sourceCandidatesFromSelection = (lookupPath, selection) => (selection.alternatives || [selection])
  .map((alternative) => sourceCandidateFromSelection(lookupPath, alternative));

const provisionSourceCandidates = (provision) => {
  if (Array.isArray(provision?.sourceCandidates) && provision.sourceCandidates.length) return provision.sourceCandidates;
  if (!provision?.magnetId || !Number.isInteger(provision.fileIndex)) return [];
  return [{
    id: sourceCandidateId(provision.lookupPath, provision.provider || 'alldebrid', provision.sourceHash || 'legacy', provision.fileIndex),
    provider: provision.provider || 'alldebrid', magnetId: provision.magnetId, fileIndex: provision.fileIndex,
    fileName: provision.fileName, sourceTitle: provision.sourceTitle, sourceHash: provision.sourceHash,
    sourceSize: provision.sourceSize, language: releaseLanguageRank(provision.sourceTitle) >= 2 ? 'VF/MULTi' : 'Autre',
    quality: /1080/i.test(provision.sourceTitle || '') ? '1080p' : /720/i.test(provision.sourceTitle || '') ? '720p' : 'SD',
    videoCodec: releaseCodecRank(provision.sourceTitle) === 2 ? 'H.264' : 'Inconnu', audioCodec: 'unknown', cached: true,
    label: 'Source principale', state: 'validated',
  }];
};

const multiSourceDiscoveries = new Set();
const discoverProvisionAlternatives = async (lookupPath) => {
  if (!multiSourceEnabled || multiSourceDiscoveries.has(lookupPath)) return;
  const current = provisions.get(lookupPath);
  if (!current?.magnetId || provisionSourceCandidates(current).length >= multiSourceMaximum) return;
  if (Date.now() - Date.parse(current.multiSourceCheckedAt || 0) < 6 * 60 * 60_000) return;
  multiSourceDiscoveries.add(lookupPath);
  try {
    const [kind, mediaId, season, episode] = lookupPath.split('/');
    const isMovie = kind === 'movie';
    const [metadata, externalIds] = await Promise.all([
      tmdbJson(isMovie ? `/movie/${mediaId}` : `/tv/${mediaId}`),
      tmdbJson(isMovie ? `/movie/${mediaId}/external_ids` : `/tv/${mediaId}/external_ids`),
    ]);
    if (!externalIds.imdb_id) return;
    const releases = await cometReleases({
      mediaType: isMovie ? 'movie' : 'series', imdbId: externalIds.imdb_id,
      season: Number(season) || undefined, episode: Number(episode) || undefined,
    });
    const fileMatcher = isMovie
      ? (files) => files.sort((left, right) => right.size - left.size)[0]
      : (files) => files.find((file) => {
        const numbers = episodeNumbersFromFile(file);
        return numbers?.season === Number(season) && numbers?.episode === Number(episode);
      });
    const selection = await selectAllDebridSource(
      lookupPath, releases, fileMatcher,
      [metadata.title, metadata.original_title, metadata.name, metadata.original_name].filter(Boolean),
      isMovie && metadata.release_date ? [Number(metadata.release_date.slice(0, 4))] : [],
      current.sourceHash, true, false, true,
    );
    const discovered = selection ? sourceCandidatesFromSelection(lookupPath, selection) : [];
    const existing = provisionSourceCandidates(provisions.get(lookupPath));
    const merged = [...new Map([...existing, ...discovered].map((candidate) => [candidate.id, candidate])).values()]
      .slice(0, multiSourceMaximum);
    await updateProvision(lookupPath, {
      sourceCandidates: merged, activeSourceId: current.activeSourceId || merged[0]?.id || null,
      multiSourceCheckedAt: new Date().toISOString(), multiSourceCount: merged.length,
    });
  } catch (error) {
    await updateProvision(lookupPath, { multiSourceCheckedAt: new Date().toISOString(), multiSourceError: error.message });
  } finally {
    multiSourceDiscoveries.delete(lookupPath);
  }
};

const writeMoviePointer = async (movie, selection) => {
  const year = String(movie.year || movie.inCinemas || movie.digitalRelease || '').slice(0, 4);
  const folder = join(streamLibraryRoot, 'movies', safeName(`${movie.title} (${year || 'inconnu'})`));
  await mkdir(folder, { recursive: true });
  const base = safeName(`${movie.title} (${year || 'inconnu'})`);
  const lookupPath = `movie/${movie.tmdbId}`;
  await writeFile(join(folder, `${base}.strm`), `http://r2-importer:8788/media/source?lookup=${encodeURIComponent(lookupPath)}\n`);
  await writeFile(join(folder, `${base}.nfo`), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<movie><title>${xml(movie.title)}</title><year>${xml(year)}</year><tmdbid>${movie.tmdbId}</tmdbid><uniqueid type="tmdb" default="true">${movie.tmdbId}</uniqueid></movie>\n`);
  const sourceCandidates = sourceCandidatesFromSelection(lookupPath, selection);
  await updateProvision(lookupPath, {
    provider: selection.provider, magnetId: selection.uploaded.id, fileIndex: selection.selected.fileIndex,
    fileName: selection.selected.name, sourceTitle: selection.release.title, sourceHash: releaseInfoHash(selection.release),
    sourceSize: selection.selected.size, sourceCandidates, activeSourceId: sourceCandidates[0]?.id || null,
    discoveryProvider: selection.discoveryProvider || (selection.release?.indexer === 'Comet' ? 'comet' : 'arr'),
  });
};

const r2EncodingQueued = new Set();
const r2EncodingForced = new Set();
const r2QueueStatePath = process.env.R2_QUEUE_STATE_PATH || '/state/r2-queue.json';
const persistedR2Jobs = new Map();
let r2QueueStateWrite = Promise.resolve();
const r2LaneQueues = [[], [], [], []];
const r2ActiveJobs = new Map();
let r2LightRunning = 0;
let r2HeavyRunning = 0;
let r2LanePumpRunning = false;
let r2PauseReason = null;
let r2RepairsPruned = 0;
const r2LightConcurrency = Math.max(1, Math.min(2, Number(process.env.R2_LIGHT_CONCURRENCY) || 2));
const r2MinimumFreeBytes = Math.max(5, Number(process.env.R2_MIN_FREE_DISK_GB) || 20) * 1024 ** 3;
const r2MaximumAttempts = Math.max(1, Math.min(10, Number(process.env.R2_MAX_ATTEMPTS) || 3));

const persistR2Queue = () => {
  r2QueueStateWrite = r2QueueStateWrite.then(async () => {
    await mkdir(dirname(r2QueueStatePath), { recursive: true });
    const temporaryPath = `${r2QueueStatePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify([...persistedR2Jobs.values()], null, 2)}\n`);
    await rename(temporaryPath, r2QueueStatePath);
  }).catch((error) => console.error(`Sauvegarde file R2: ${error.message}`));
  return r2QueueStateWrite;
};

const r2LaneDepths = () => ({
  light: r2LaneQueues.flat().filter((job) => job.lane === 'light').length,
  heavy: r2LaneQueues.flat().filter((job) => job.lane === 'heavy').length,
  unclassified: r2LaneQueues.flat().filter((job) => !job.lane).length,
  activeLight: r2LightRunning,
  activeHeavy: r2HeavyRunning,
});

const r2DiskHasCapacity = async () => {
  const filesystem = await statfs(tmpdir());
  return Number(filesystem.bavail) * Number(filesystem.bsize) >= r2MinimumFreeBytes;
};

const r2SourcePath = (lookupPath) => `http://r2-importer:8788/media/source?lookup=${encodeURIComponent(lookupPath)}`;
const r2CanaryAllowsJob = (job) => r2HlsLayout !== 'byterange-fmp4'
  || r2Fmp4CanaryLimit === 0
  || r2Fmp4Canaries.size < r2Fmp4CanaryLimit
  || r2Fmp4Canaries.has(job.lookupPath);

const classifyR2Job = async (job) => {
  const profile = await mediaProfile(r2SourcePath(job.lookupPath));
  job.profile = profile;
  job.lane = profile.videoCodec === 'h264' && profile.height > 0 && profile.height <= 1080 ? 'light' : 'heavy';
  persistedR2Jobs.set(job.jobKey, { ...persistedR2Jobs.get(job.jobKey), lane: job.lane, profile });
  await persistR2Queue();
};

const finishR2Job = async (job) => {
  r2EncodingQueued.delete(job.jobKey);
  r2EncodingForced.delete(job.jobKey);
  persistedR2Jobs.delete(job.jobKey);
  r2ActiveJobs.delete(job.jobKey);
  await persistR2Queue();
};

const executeR2Job = async (job) => {
  const { jobKey, lookupPath, title, quality } = job;
  try {
    const shouldForce = job.force || r2EncodingForced.has(jobKey);
    if (quality === '720p' && !shouldForce && await hasCurrentCatalog(lookupPath)) {
      await updateProvision(lookupPath, { availabilityState: 'r2_ready', r2ReadyAt: provisions.get(lookupPath)?.r2ReadyAt || new Date().toISOString() });
      if (job.priority === 3) r2RepairsPruned += 1;
      return;
    }
    if (quality === '1080p' && (!shouldForce && await hasR2Variant(lookupPath, quality))) return;
    const r2EncodingStartedAt = new Date().toISOString();
    await updateProvision(lookupPath, { [`r2${quality}EncodingStartedAt`]: r2EncodingStartedAt, r2LastError: null });
    const encoding = await encodeAndUpload({
      sourcePath: r2SourcePath(lookupPath), objectPrefix: `hls/${lookupPath}`,
      manifests: [{ lookupPath, title: title || lookupPath }], quality, profileHint: job.profile,
      backgroundLane: job.lane,
    });
    const r2ReadyAt = new Date().toISOString();
    await updateProvision(lookupPath, {
      availabilityState: 'r2_ready', r2ReadyAt, r2RefreshRequired: false, [`r2${quality}ReadyAt`]: r2ReadyAt,
      [`r2${quality}EncodingSeconds`]: Math.max(0, Math.round((Date.parse(r2ReadyAt) - Date.parse(r2EncodingStartedAt)) / 1000)),
      [`r2${quality}DeliveryMode`]: encoding.deliveryMode, [`r2${quality}VideoCodec`]: encoding.videoCodec,
      [`r2${quality}AudioCopied`]: encoding.audioCopied, [`r2${quality}Bytes`]: encoding.bytes,
      [`r2${quality}ObjectCount`]: encoding.objectCount, r2FailureCount: 0, r2RetryAt: null, r2FailureSourceHash: null,
    });
    if (quality === '720p' && process.env.ENABLE_BACKGROUND_1080P === 'true' && r2EncodingQueued.size === 1) {
      scheduleR2Encoding(lookupPath, title, false, 3, '1080p');
    }
  } catch (error) {
    const current = provisions.get(lookupPath) || {};
    const previousFailures = current.r2FailureSourceHash === job.sourceHash ? Number(current.r2FailureCount || 0) : 0;
    const failureCount = previousFailures + 1;
    const retryDelays = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
    const retryAt = failureCount < r2MaximumAttempts
      ? new Date(Date.now() + retryDelays[Math.min(retryDelays.length - 1, failureCount - 1)]).toISOString()
      : null;
    await updateProvision(lookupPath, {
      r2FailureCount: failureCount, r2FailureSourceHash: job.sourceHash,
      r2RetryAt: retryAt, r2LastError: error.message, r2LastFailedAt: new Date().toISOString(),
    });
    throw error;
  } finally {
    await finishR2Job(job);
  }
};

const drainR2Lanes = async () => {
  if (r2LanePumpRunning) return;
  r2LanePumpRunning = true;
  try {
    if (!await r2DiskHasCapacity()) {
      r2PauseReason = 'disk';
      return;
    }
    if (interactiveLiveTranscodes() > 0) {
      r2PauseReason = 'interactive-playback';
      return;
    }
    r2PauseReason = null;
    const unknown = r2LaneQueues.flat().filter((job) => !job.lane).slice(0, 8);
    for (let index = 0; index < unknown.length; index += 4) {
      await Promise.all(unknown.slice(index, index + 4).map((job) => classifyR2Job(job).catch((error) => {
        job.lane = 'heavy';
        job.profile = { videoCodec: '', width: 0, height: 0, duration: 0 };
        console.warn(`Profil R2 ${job.lookupPath}: ${error.message}`);
      })));
    }
    // A viewer may have arrived while the asynchronous source probes above
    // were running. Re-check before consuming any CPU or network slot.
    if (interactiveLiveTranscodes() > 0) {
      r2PauseReason = 'interactive-playback';
      return;
    }
    const launchNext = (lane) => {
      for (const queue of r2LaneQueues) {
        const candidates = queue
          .map((job, index) => ({ job, index }))
          .filter(({ job }) => job.lane === lane && r2CanaryAllowsJob(job));
        if (!candidates.length) continue;
        candidates.sort((left, right) => {
          const leftPreload = Boolean(left.job.preload ?? provisions.get(left.job.lookupPath)?.preload);
          const rightPreload = Boolean(right.job.preload ?? provisions.get(right.job.lookupPath)?.preload);
          if (leftPreload !== rightPreload) return leftPreload ? -1 : 1;
          return left.index - right.index;
        });
        return queue.splice(candidates[0].index, 1)[0];
      }
      return null;
    };
    const launch = (job) => {
      if (!job) return;
      if (job.lane === 'light') r2LightRunning += 1;
      else r2HeavyRunning += 1;
      r2ActiveJobs.set(job.jobKey, job);
      console.log(`[${new Date().toISOString()}] Début R2 ${job.lane} P${job.priority} ${job.quality} ${job.lookupPath}`);
      executeR2Job(job).then(
        () => console.log(`[${new Date().toISOString()}] Fin R2 ${job.lane} P${job.priority} ${job.quality} ${job.lookupPath}`),
        (error) => console.error(`[${new Date().toISOString()}] Échec R2 ${job.lane} P${job.priority} ${job.quality} ${job.lookupPath}: ${error.message}`),
      ).finally(() => {
        if (job.lane === 'light') r2LightRunning -= 1;
        else r2HeavyRunning -= 1;
        queueMicrotask(drainR2Lanes);
      });
    };
    let launched = false;
    while (r2LightRunning < r2LightConcurrency) {
      const job = launchNext('light');
      if (!job) break;
      launch(job);
      launched = true;
    }
    if (r2HeavyRunning < 1) {
      const job = launchNext('heavy');
      if (job) { launch(job); launched = true; }
    }
    if (!launched && r2EncodingQueued.size > r2ActiveJobs.size && r2Fmp4CanaryLimit > 0 && r2Fmp4Canaries.size >= r2Fmp4CanaryLimit) {
      r2PauseReason = 'canary-validation';
    }
  } finally {
    r2LanePumpRunning = false;
  }
};

const r2PriorityForLookup = (lookupPath, { force = false, interactive = false, priorityOverride = null } = {}) => {
  if (priorityOverride != null) return Math.max(0, Math.min(3, Number(priorityOverride) || 0));
  if (interactive || provisions.get(lookupPath)?.preload) return 0;
  if (force) return 1;
  return 3;
};

const reprioritizeR2Queue = () => {
  const reserved = new Set([...r2ActiveJobs.keys()]);
  const allJobs = r2LaneQueues.flat();
  for (const queue of r2LaneQueues) queue.length = 0;
  for (const job of allJobs) {
    if (reserved.has(job.jobKey)) {
      r2LaneQueues[job.priority].push(job);
      continue;
    }
    const isPreload = Boolean(job.preload ?? provisions.get(job.lookupPath)?.preload);
    const priority = isPreload ? 0 : (job.force ? 1 : 3);
    job.priority = priority;
    job.preload = isPreload;
    persistedR2Jobs.set(job.jobKey, job);
    r2LaneQueues[priority].push(job);
  }
  for (const queue of r2LaneQueues) {
    queue.sort((left, right) => {
      const leftPreload = Boolean(left.preload ?? provisions.get(left.lookupPath)?.preload);
      const rightPreload = Boolean(right.preload ?? provisions.get(right.lookupPath)?.preload);
      if (leftPreload !== rightPreload) return leftPreload ? -1 : 1;
      return 0;
    });
  }
  persistR2Queue();
};

const scheduleR2Encoding = (lookupPath, title, force = false, priorityOverride = null, quality = '720p') => {
  const sourceHash = String(provisions.get(lookupPath)?.sourceHash || 'unknown');
  const jobKey = `${lookupPath}:${sourceHash}:${quality}`;
  const current = provisions.get(lookupPath) || {};
  const isPreload = Boolean(current.preload);
  const priority = r2PriorityForLookup(lookupPath, { force, priorityOverride });
  if (priority > 0 && !force && current.r2FailureSourceHash === sourceHash && Number(current.r2FailureCount || 0) >= r2MaximumAttempts) return;
  if (priority > 0 && !force && current.r2RetryAt && Date.parse(current.r2RetryAt) > Date.now()) return;
  if (force) r2EncodingForced.add(jobKey);
  if (r2EncodingQueued.has(jobKey)) {
    const active = r2ActiveJobs.get(jobKey);
    const queued = active || persistedR2Jobs.get(jobKey);
    if (queued && priority < Number(queued.priority)) {
      queued.priority = priority;
      persistedR2Jobs.set(jobKey, queued);
      if (!active) {
        for (const queue of r2LaneQueues) {
          const index = queue.findIndex((candidate) => candidate.jobKey === jobKey);
          if (index >= 0) queue.splice(index, 1);
        }
        r2LaneQueues[priority].push(queued);
      }
      persistR2Queue();
    }
    return;
  }
  const saved = persistedR2Jobs.get(jobKey) || {};
  const job = { ...saved, jobKey, lookupPath, title, force, priority, quality, sourceHash, preload: isPreload };
  r2EncodingQueued.add(jobKey);
  persistedR2Jobs.set(jobKey, job);
  persistR2Queue();
  r2LaneQueues[priority].push(job);
  queueMicrotask(drainR2Lanes);
};

const cancelQueuedR2Encoding = async (lookupPath, quality = '720p') => {
  if ([...r2ActiveJobs.values()].some((job) => job.lookupPath === lookupPath && job.quality === quality)) return false;
  const matchingKeys = [...persistedR2Jobs.entries()]
    .filter(([, job]) => job.lookupPath === lookupPath && job.quality === quality)
    .map(([jobKey]) => jobKey);
  if (!matchingKeys.length) return false;
  for (const jobKey of matchingKeys) {
    persistedR2Jobs.delete(jobKey);
    r2EncodingQueued.delete(jobKey);
    r2EncodingForced.delete(jobKey);
    for (const queue of r2LaneQueues) {
      const index = queue.findIndex((job) => job.jobKey === jobKey);
      if (index >= 0) queue.splice(index, 1);
    }
  }
  await persistR2Queue();
  return true;
};

const tmdbJson = async (path) => {
  const response = await fetch(`https://api.themoviedb.org/3${path}${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(process.env.VITE_TMDB_API)}&language=fr-FR`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`TMDB a répondu ${response.status}.`);
  return response.json();
};

const provisionMovie = async (tmdbId, force = false, preferredSourceHash = '', background = false) => {
  const lookupPath = `movie/${tmdbId}`;
  await updateProvision(lookupPath, { status: 'waiting-arr', stage: 'catalogue', progress: 12, etaSeconds: null, etaKind: null, message: 'On retrouve votre film…', error: null });
  const tmdbMovie = await tmdbJson(`/movie/${tmdbId}`);
  if (!tmdbMovie.release_date || tmdbMovie.release_date > new Date().toISOString().slice(0, 10)) {
    const error = new Error('Ce film n’est pas encore sorti. Il sera vérifié automatiquement à sa sortie.');
    error.retryAt = tmdbMovie.release_date
      ? new Date(`${tmdbMovie.release_date}T12:00:00Z`).toISOString()
      : new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
    error.publicMessage = tmdbMovie.release_date
      ? `Sortie prévue le ${new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${tmdbMovie.release_date}T12:00:00Z`))}. Le film sera recherché automatiquement dès sa sortie.`
      : 'La date de sortie n’est pas encore connue. Une nouvelle vérification est prévue automatiquement.';
    throw error;
  }
  let movie;
  for (let attempt = 0; attempt < 30 && !movie; attempt += 1) {
    const movies = await arrJson(process.env.RADARR_URL, process.env.RADARR_API_KEY, `/api/v3/movie?tmdbId=${tmdbId}`);
    movie = Array.isArray(movies) ? movies[0] : movies;
    if (!movie) await sleep(2000);
  }
  if (!movie) throw new Error('Radarr n’a pas créé le film après la demande Seerr.');
  await updateProvision(lookupPath, { status: 'searching', stage: 'recherche', progress: 22, etaSeconds: null, etaKind: null, message: 'On choisit la meilleure version disponible…', title: movie.title });
  const expectedTitles = [
    movie.title,
    movie.originalTitle,
    tmdbMovie.title,
    tmdbMovie.original_title,
    ...(movie.alternateTitles || []).map((item) => item.title),
  ].filter(Boolean);
  const expectedYear = Number(movie.year || String(tmdbMovie.release_date || '').slice(0, 4));
  const selection = await selectPrimaryMediaSource({
    lookupPath,
    cometParams: { mediaType: 'movie', imdbId: movie.imdbId },
    loadFallbackReleases: () => arrJson(process.env.RADARR_URL, process.env.RADARR_API_KEY, `/api/v3/release?movieId=${movie.id}`),
    fileMatcher: (files) => files.sort((left, right) => right.size - left.size)[0],
    expectedTitles,
    expectedYears: Number.isInteger(expectedYear) ? [expectedYear] : [],
    preferredSourceHash,
    preferFastPreload: background,
  });
  await updateProvision(lookupPath, { status: 'publishing', stage: 'jellyfin', progress: 86, etaSeconds: null, etaKind: null, message: 'Derniers préparatifs avant la lecture…' });
  await writeMoviePointer(movie, selection);
  await refreshJellyfin();
  await updateProvision(lookupPath, { status: 'ready', availabilityState: 'source_ready', stage: 'ready', progress: 100, etaSeconds: 0, readyAt: new Date().toISOString(), message: 'Le film est prêt. Bonne séance !', r2RefreshRequired: force });
  // Never probe the debrid source and run the full R2 encoder against the same
  // unlocked URL concurrently. Some providers terminate one of those streams,
  // which made playback appear stuck even though the torrent was cached.
  prepareDirectSource(lookupPath)
    .catch((error) => console.warn(`Préparation lecture ${lookupPath}: ${error.message}`))
    .finally(() => scheduleR2Encoding(lookupPath, movie.title, force, null, '720p'));
};

const provisionEpisode = async (tmdbId, seasonNumber, episodeNumber, force = false, preferredSourceHash = '', background = false) => {
  const lookupPath = `episode/${tmdbId}/${seasonNumber}/${episodeNumber}`;
  await updateProvision(lookupPath, { status: 'waiting-arr', stage: 'catalogue', progress: 12, etaSeconds: null, etaKind: null, message: 'On retrouve cet épisode…', error: null });
  const externalIds = await tmdbJson(`/tv/${tmdbId}/external_ids`);
  let series;
  for (let attempt = 0; attempt < 30 && !series; attempt += 1) {
    const allSeries = await arrJson(process.env.SONARR_URL, process.env.SONARR_API_KEY, '/api/v3/series');
    series = allSeries.find((item) => Number(item.tvdbId) === Number(externalIds.tvdb_id));
    if (!series) await sleep(2000);
  }
  if (!series) throw new Error('Sonarr n’a pas créé la série après la demande Seerr.');
  const episodes = await arrJson(process.env.SONARR_URL, process.env.SONARR_API_KEY, `/api/v3/episode?seriesId=${series.id}`);
  const episode = episodes.find((item) => Number(item.seasonNumber) === seasonNumber && Number(item.episodeNumber) === episodeNumber);
  if (!episode) throw new Error(`Épisode S${seasonNumber}E${episodeNumber} introuvable dans Sonarr.`);
  const details = await tmdbJson(`/tv/${tmdbId}`);
  const expectedTitles = [series.title, details.name, details.original_name, ...(series.alternateTitles || []).map((item) => item.title)].filter(Boolean);
  await updateProvision(lookupPath, { status: 'searching', stage: 'recherche', progress: 22, etaSeconds: null, etaKind: null, message: 'On choisit la meilleure version disponible…', title: `${series.title} S${seasonNumber}E${episodeNumber}` });
  const token = `s${String(seasonNumber).padStart(2, '0')}e${String(episodeNumber).padStart(2, '0')}`;
  const selection = await selectPrimaryMediaSource({
    lookupPath,
    cometParams: { mediaType: 'series', imdbId: series.imdbId, season: seasonNumber, episode: episodeNumber },
    loadFallbackReleases: () => arrJson(process.env.SONARR_URL, process.env.SONARR_API_KEY, `/api/v3/release?episodeId=${episode.id}`),
    fileMatcher: (files) => files.find((file) => {
      const numbers = episodeNumbersFromFile(file);
      return (numbers?.season === seasonNumber && numbers?.episode === episodeNumber)
        || file.name.toLowerCase().replace(/[ ._-]+/g, '').includes(token);
    }),
    expectedTitles,
    expectedYears: [],
    preferredSourceHash,
    preferFastPreload: background,
  });
  const year = String(details.first_air_date || '').slice(0, 4);
  const seriesFolder = join(streamLibraryRoot, 'tv', safeName(`${details.name || series.title} (${year || 'inconnu'})`));
  await mkdir(seriesFolder, { recursive: true });
  await writeFile(join(seriesFolder, 'tvshow.nfo'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<tvshow><title>${xml(details.name || series.title)}</title><year>${xml(year)}</year><tmdbid>${tmdbId}</tmdbid><uniqueid type="tmdb" default="true">${tmdbId}</uniqueid><tvdbid>${externalIds.tvdb_id}</tvdbid></tvshow>\n`);
  const selectedSourceCandidates = sourceCandidatesFromSelection(lookupPath, selection);
  await updateProvision(lookupPath, {
    status: 'publishing', stage: 'jellyfin', progress: 86, etaSeconds: null, etaKind: null,
    message: 'Derniers préparatifs avant la lecture…', provider: selection.provider,
    magnetId: selection.uploaded.id, fileIndex: selection.selected.fileIndex, fileName: selection.selected.name,
    sourceTitle: selection.release.title, sourceHash: releaseInfoHash(selection.release), sourceSize: selection.selected.size,
    sourceCandidates: selectedSourceCandidates, activeSourceId: selectedSourceCandidates[0]?.id || null,
  });

  // A season or multi-season pack is resolved once, then every identifiable
  // episode is published immediately. Following episodes therefore open
  // without another search or another AllDebrid round trip.
  const episodeByKey = new Map(episodes.map((item) => [`${Number(item.seasonNumber)}:${Number(item.episodeNumber)}`, item]));
  const packFiles = (selection.files || videoFiles(selection.status)).map((file) => {
    const numbers = episodeNumbersFromFile(file);
    return numbers ? { file, ...numbers } : null;
  }).filter(Boolean).filter((item) => episodeByKey.has(`${item.season}:${item.episode}`)).slice(0, 100);
  if (!packFiles.some((item) => item.season === seasonNumber && item.episode === episodeNumber)) {
    packFiles.push({ file: selection.selected, season: seasonNumber, episode: episodeNumber });
  }
  for (const entry of packFiles) {
    const entryLookupPath = `episode/${tmdbId}/${entry.season}/${entry.episode}`;
    const episodeMetadata = episodeByKey.get(`${entry.season}:${entry.episode}`);
    const seasonFolder = join(seriesFolder, `Season ${String(entry.season).padStart(2, '0')}`);
    const base = `${safeName(details.name || series.title)} S${String(entry.season).padStart(2, '0')}E${String(entry.episode).padStart(2, '0')}`;
    await mkdir(seasonFolder, { recursive: true });
    await writeFile(join(seasonFolder, `${base}.strm`), `http://r2-importer:8788/media/source?lookup=${encodeURIComponent(entryLookupPath)}\n`);
    await writeFile(join(seasonFolder, `${base}.nfo`), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<episodedetails><title>${xml(episodeMetadata?.title || base)}</title><season>${entry.season}</season><episode>${entry.episode}</episode></episodedetails>\n`);
    const entryCandidates = (selection.alternatives || [selection]).map((alternative) => {
      const matchingFile = (alternative.files || []).find((file) => {
        const numbers = episodeNumbersFromFile(file);
        return numbers?.season === entry.season && numbers?.episode === entry.episode;
      });
      return matchingFile ? sourceCandidateFromSelection(entryLookupPath, alternative, matchingFile) : null;
    }).filter(Boolean);
    if (!entryCandidates.length) entryCandidates.push(sourceCandidateFromSelection(entryLookupPath, selection, entry.file));
    const primaryCandidate = entryCandidates[0];
    await updateProvision(entryLookupPath, {
      status: 'ready', availabilityState: 'source_ready', stage: 'ready', progress: 100, etaSeconds: 0,
      message: 'L’épisode est prêt. Bonne séance !', readyAt: new Date().toISOString(),
      title: `${series.title} S${entry.season}E${entry.episode}`,
      provider: selection.provider, magnetId: selection.uploaded.id, fileIndex: entry.file.fileIndex, fileName: entry.file.name,
      sourceTitle: selection.release.title, sourceHash: releaseInfoHash(selection.release), sourceSize: entry.file.size, error: null,
      sourceCandidates: entryCandidates, activeSourceId: primaryCandidate.id,
      discoveryProvider: selection.discoveryProvider || (selection.release?.indexer === 'Comet' ? 'comet' : 'arr'),
      r2RefreshRequired: force,
    });
    prepareDirectSource(entryLookupPath)
      .catch((error) => console.warn(`Préparation lecture ${entryLookupPath}: ${error.message}`))
      .finally(() => {
        if (force || (entry.season === seasonNumber && entry.episode === episodeNumber)) {
          scheduleR2Encoding(
            entryLookupPath,
            `${details.name || series.title} — S${String(entry.season).padStart(2, '0')}E${String(entry.episode).padStart(2, '0')}`,
            force, null, '720p',
          );
        }
      });
  }
  await refreshJellyfin();
};

const provisionQueue = [];
let runningProvisions = 0;
let runningBackgroundProvisions = 0;
const provisionConcurrency = Math.max(1, Math.min(3, Number(process.env.PROVISION_CONCURRENCY) || 2));
const backgroundProvisionConcurrency = Math.max(1, Math.min(2, Number(process.env.BACKGROUND_PROVISION_CONCURRENCY) || 2));

const drainProvisionQueue = () => {
  while (runningProvisions < provisionConcurrency && provisionQueue.length) {
    provisionQueue.sort((left, right) => Number(left.priority || 0) - Number(right.priority || 0));
    const interactiveIndex = provisionQueue.findIndex((item) => !item.background);
    const jobIndex = interactiveIndex >= 0
      ? interactiveIndex
      : runningBackgroundProvisions < backgroundProvisionConcurrency
        ? provisionQueue.findIndex((item) => item.background)
        : -1;
    if (jobIndex < 0) break;
    const [job] = provisionQueue.splice(jobIndex, 1);
    if (!job.force && provisions.get(job.lookupPath)?.status === 'ready') {
      activeProvisions.delete(job.lookupPath);
      continue;
    }
    runningProvisions += 1;
    if (job.background) runningBackgroundProvisions += 1;
    updateProvision(job.lookupPath, {
      status: 'queued', availabilityState: 'preparing', attemptId: job.attemptId,
      attemptStartedAt: new Date().toISOString(), stage: 'queue', progress: 5,
      etaSeconds: null, etaKind: null, message: job.background ? 'Préparation anticipée du catalogue…' : 'Votre séance se prépare…',
      error: null, preload: Boolean(job.background), preloadRating: job.rating || null, preloadPage: job.page || null,
      ...(job.force ? {
        provider: null, magnetId: null, fileIndex: null, fileName: null,
        sourceTitle: null, sourceHash: null, sourceSize: null,
        sourceCandidates: [], activeSourceId: null, discoveryProvider: null,
        readyAt: null, multiSourceCheckedAt: null, multiSourceCount: 0,
      } : {}),
    })
      .then(() => job.mediaType === 'movie'
        ? provisionMovie(job.mediaId, job.force, job.sourceHash, job.background)
        : provisionEpisode(job.mediaId, job.season, job.episode, job.force, job.sourceHash, job.background))
      .catch(async (error) => {
        console.error(`Provision ${job.lookupPath}: ${error.message}`);
        const timedOut = /timeout|aborted/i.test(String(error.message || ''));
        const retryAt = error.retryAt || new Date(Date.now() + (timedOut ? 5 * 60_000 : 6 * 60 * 60_000)).toISOString();
        const message = error.publicMessage || (timedOut
          ? 'La recherche prend plus de temps que prévu. Une nouvelle tentative sera lancée dans quelques minutes.'
          : 'Aucun fichier n’est disponible pour le moment. Nous réessaierons automatiquement plus tard.');
        await updateProvision(job.lookupPath, { status: 'retrying', availabilityState: 'failed', stage: 'retry', progress: Math.max(15, provisions.get(job.lookupPath)?.progress || 15), etaSeconds: null, etaKind: null, message, error: error.message, retryAt });
      })
      .finally(() => {
        activeProvisions.delete(job.lookupPath);
        runningProvisions -= 1;
        if (job.background) runningBackgroundProvisions -= 1;
        drainProvisionQueue();
      });
  }
};

const startProvision = (body) => {
  const mediaId = Number(body.mediaId);
  const mediaType = body.mediaType === 'tv' ? 'tv' : 'movie';
  const season = Math.max(1, Number(body.season ?? body.seasons?.[0]) || 1);
  const episode = Math.max(1, Number(body.episode) || 1);
  const force = body.force === true;
  const background = body.background === true;
  const attemptId = randomUUID();
  const sourceHash = /^[a-f0-9]{40}$/i.test(String(body.sourceHash || '')) ? String(body.sourceHash).toLowerCase() : '';
  const lookupPath = mediaType === 'movie' ? `movie/${mediaId}` : `episode/${mediaId}/${season}/${episode}`;
  const current = provisions.get(lookupPath);
  if (activeProvisions.has(lookupPath)) return publicProvision(current);
  if (!force && current?.status === 'retrying' && Date.parse(current.retryAt || 0) > Date.now()) return publicProvision(current);
  if (!force && current?.status === 'ready') {
    provisionStatusPublish = provisionStatusPublish
      .then(() => publishProvisionStatus(lookupPath, current))
      .catch((error) => console.error(`Publication statut ${lookupPath}: ${error.message}`));
    scheduleR2Encoding(lookupPath, current.title);
    return publicProvision(current);
  }
  activeProvisions.add(lookupPath);
  provisionQueue.push({
    lookupPath, mediaType, mediaId, season, episode, force, sourceHash, attemptId,
    background, priority: background ? 3 : 0, rating: Number(body.rating) || null, page: Number(body.page) || null,
  });
  drainProvisionQueue();
  return publicProvision(provisions.get(lookupPath));
};

const cataloguePreloadEnabled = process.env.CATALOGUE_PRELOAD_ENABLED !== 'false';
const r2OnDemandOnly = process.env.R2_ON_DEMAND_ONLY !== 'false';
const cataloguePreloadIntervalMs = Math.max(60, Number(process.env.CATALOGUE_PRELOAD_INTERVAL_SECONDS) || 300) * 1000;
const cataloguePreloadMaxR2Pending = Math.max(10, Number(process.env.CATALOGUE_PRELOAD_MAX_R2_PENDING) || 32);
const cataloguePreloadMaxPage = Math.max(1, Math.min(500, Number(process.env.CATALOGUE_PRELOAD_MAX_PAGE) || 500));
const cataloguePreloadBatchSize = Math.max(1, Math.min(5, Number(process.env.CATALOGUE_PRELOAD_BATCH_SIZE) || 3));
const cataloguePreloadStatePath = process.env.CATALOGUE_PRELOAD_STATE_PATH || '/state/catalogue-preload.json';
let cataloguePreloadRunning = false;
let cataloguePreloadState = {
  page: 1, offset: 0, queued: 0, skipped: 0, errors: 0,
  lastQueuedAt: null, lastLookupPath: null, lastError: null, failures: {},
};
let cataloguePreloadStateWrite = Promise.resolve();

const saveCataloguePreloadState = () => {
  cataloguePreloadStateWrite = cataloguePreloadStateWrite.then(async () => {
    await mkdir(dirname(cataloguePreloadStatePath), { recursive: true });
    const temporaryPath = `${cataloguePreloadStatePath}.tmp`;
    const persisted = { ...cataloguePreloadState, failures: Object.fromEntries(Object.entries(cataloguePreloadState.failures || {}).slice(-100)) };
    await writeFile(temporaryPath, `${JSON.stringify(persisted, null, 2)}\n`);
    await rename(temporaryPath, cataloguePreloadStatePath);
  }).catch((error) => console.error(`Sauvegarde préchargement catalogue: ${error.message}`));
  return cataloguePreloadStateWrite;
};

const loadCataloguePreloadState = async () => {
  try {
    const saved = JSON.parse(await readFile(cataloguePreloadStatePath, 'utf8'));
    cataloguePreloadState = {
      ...cataloguePreloadState, ...saved,
      page: Math.max(1, Math.min(cataloguePreloadMaxPage, Number(saved.page) || 1)),
      offset: Math.max(0, Number(saved.offset) || 0), failures: saved.failures || {},
    };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`État préchargement catalogue illisible: ${error.message}`);
  }
};

const cataloguePreloadCandidates = async (page) => {
  const today = new Date().toISOString().slice(0, 10);
  const common = `page=${page}&sort_by=vote_average.desc&vote_count.gte=300&include_adult=false`;
  const [movies, series] = await Promise.all([
    tmdbJson(`/discover/movie?${common}&primary_release_date.lte=${today}&region=FR`),
    tmdbJson(`/discover/tv?${common}&first_air_date.lte=${today}&include_null_first_air_dates=false`),
  ]);
  return [
    ...(movies.results || []).map((item) => ({ ...item, mediaType: 'movie', lookupPath: `movie/${item.id}` })),
    ...(series.results || []).map((item) => ({ ...item, mediaType: 'tv', lookupPath: `episode/${item.id}/1/1` })),
  ]
    .filter((item) => item.id && item.poster_path)
    .sort((left, right) => Number(right.vote_average || 0) - Number(left.vote_average || 0));
};

const requestCatalogueCandidateInSeerr = async (candidate) => {
  const apiKey = await seerrApiKey();
  const baseUrl = String(process.env.SEERR_URL || 'http://seerr:5055').replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json', 'X-Api-Key': apiKey };
  const existingResponse = await fetch(`${baseUrl}/api/v1/${candidate.mediaType}/${candidate.id}`, {
    headers, signal: AbortSignal.timeout(10_000),
  });
  let alreadyRequested = false;
  if (existingResponse.ok) {
    const existing = await existingResponse.json();
    alreadyRequested = Boolean(existing.mediaInfo) || (existing.mediaInfo?.requests || []).length > 0;
  }
  if (!alreadyRequested) {
    const payload = candidate.mediaType === 'movie'
      ? { mediaType: 'movie', mediaId: Number(candidate.id) }
      : { mediaType: 'tv', mediaId: Number(candidate.id), seasons: [1] };
    const response = await fetch(`${baseUrl}/api/v1/request`, {
      method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok && response.status !== 409) throw new Error(`Seerr a répondu ${response.status}.`);
  }
};

const runCataloguePreload = async () => {
  if (!cataloguePreloadEnabled || cataloguePreloadRunning) return;
  if (runningBackgroundProvisions > 0 || provisionQueue.some((item) => item.background)) return;
  if (r2EncodingQueued.size >= cataloguePreloadMaxR2Pending) return;
  cataloguePreloadRunning = true;
  try {
    let candidates = await cataloguePreloadCandidates(cataloguePreloadState.page);
    if (cataloguePreloadState.offset >= candidates.length) {
      cataloguePreloadState.page = cataloguePreloadState.page >= cataloguePreloadMaxPage ? 1 : cataloguePreloadState.page + 1;
      cataloguePreloadState.offset = 0;
      candidates = await cataloguePreloadCandidates(cataloguePreloadState.page);
    }
    let queuedThisRun = 0;
    while (cataloguePreloadState.offset < candidates.length) {
      const candidate = candidates[cataloguePreloadState.offset];
      if (provisions.has(candidate.lookupPath) || activeProvisions.has(candidate.lookupPath)) {
        cataloguePreloadState.offset += 1;
        cataloguePreloadState.skipped += 1;
        continue;
      }
      if (r2EncodingQueued.size >= cataloguePreloadMaxR2Pending) break;
      try {
        await requestCatalogueCandidateInSeerr(candidate);
        startProvision({
          mediaType: candidate.mediaType, mediaId: candidate.id, season: 1, episode: 1,
          background: true, rating: candidate.vote_average, page: cataloguePreloadState.page,
        });
        cataloguePreloadState.offset += 1;
        cataloguePreloadState.queued += 1;
        cataloguePreloadState.lastQueuedAt = new Date().toISOString();
        cataloguePreloadState.lastLookupPath = candidate.lookupPath;
        cataloguePreloadState.lastError = null;
        delete cataloguePreloadState.failures[candidate.lookupPath];
        console.log(`Préchargement P${cataloguePreloadState.page}: ${candidate.lookupPath} (${Number(candidate.vote_average || 0).toFixed(1)}/10)`);
        queuedThisRun += 1;
        if (queuedThisRun >= cataloguePreloadBatchSize) break;
      } catch (error) {
        const failures = Number(cataloguePreloadState.failures[candidate.lookupPath] || 0) + 1;
        cataloguePreloadState.failures[candidate.lookupPath] = failures;
        cataloguePreloadState.errors += 1;
        cataloguePreloadState.lastError = `${candidate.lookupPath}: ${error.message}`;
        if (failures >= 3) cataloguePreloadState.offset += 1;
        console.error(`Préchargement ${candidate.lookupPath} (${failures}/3): ${error.message}`);
      }
    }
    await saveCataloguePreloadState();
  } catch (error) {
    cataloguePreloadState.errors += 1;
    cataloguePreloadState.lastError = error.message;
    await saveCataloguePreloadState();
    console.error(`Préchargement catalogue: ${error.message}`);
  } finally {
    cataloguePreloadRunning = false;
  }
};

const vfUpgradeIntervalMs = Math.max(1, Number(process.env.VF_UPGRADE_CHECK_INTERVAL_HOURS) || 6) * 60 * 60_000;
const vfUpgradeBatchSize = Math.max(1, Math.min(5, Number(process.env.VF_UPGRADE_BATCH_SIZE) || 2));
let vfUpgradeScanRunning = false;

const replaceReadyProvisionWithFrench = async (current, frenchRelease, metadata) => {
  const parts = current.lookupPath.split('/');
  const isMovie = parts[0] === 'movie';
  const tmdbId = Number(parts[1]);
  const season = Number(parts[2]);
  const episode = Number(parts[3]);
  activeProvisions.add(current.lookupPath);
  try {
    const expectedTitles = isMovie
      ? [metadata.title, metadata.original_title, current.title].filter(Boolean)
      : [metadata.name, metadata.original_name, current.title].filter(Boolean);
    const year = isMovie ? Number(String(metadata.release_date || '').slice(0, 4)) : null;
    const token = `s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`;
    const selection = await selectAllDebridSource(
      current.lookupPath,
      [frenchRelease],
      (files) => isMovie
        ? files.sort((left, right) => right.size - left.size)[0]
        : files.find((file) => {
          const numbers = episodeNumbersFromFile(file);
          return (numbers?.season === season && numbers?.episode === episode)
            || file.name.toLowerCase().replace(/[ ._-]+/g, '').includes(token);
        }),
      expectedTitles,
      Number.isInteger(year) ? [year] : [],
      releaseInfoHash(frenchRelease),
      true,
    );
    if (selection.provider === 'alldebrid' && await sourceHasFrenchAudio(selection.selected) === false) {
      await deleteMagnet(selection.uploaded.id);
      throw new Error('La source annoncée comme française ne contient pas de piste audio française vérifiable.');
    }
    await updateProvision(current.lookupPath, {
      status: 'ready', stage: 'ready', progress: 100, etaSeconds: 0, etaKind: null,
      message: isMovie ? 'Le film est prêt. Bonne séance !' : 'L’épisode est prêt. Bonne séance !',
      readyAt: new Date().toISOString(), provider: selection.provider,
      magnetId: selection.uploaded.id, fileIndex: selection.selected.fileIndex,
      fileName: selection.selected.name, sourceTitle: selection.release.title,
      sourceHash: releaseInfoHash(selection.release), sourceSize: selection.selected.size,
      vfLastCheckedAt: new Date().toISOString(), vfUpgradedAt: new Date().toISOString(),
      r2RefreshRequired: true, error: null,
    });
    await refreshJellyfin();
    scheduleR2Encoding(current.lookupPath, current.title, true, 2, '720p');
    return true;
  } catch (error) {
    // The old source remains valid until every step of the French replacement
    // succeeds. Restore its ready state if a candidate proves unusable.
    await updateProvision(current.lookupPath, {
      ...current, status: 'ready', stage: 'ready', progress: 100,
      vfLastCheckedAt: new Date().toISOString(), vfUpgradeError: error.message,
    });
    console.error(`Mise à niveau VF ${current.lookupPath}: ${error.message}`);
    return false;
  } finally {
    activeProvisions.delete(current.lookupPath);
  }
};

const runVfUpgradeScan = async () => {
  if (vfUpgradeScanRunning) return;
  vfUpgradeScanRunning = true;
  try {
    const candidates = [...provisions.values()]
      .filter((item) => item.status === 'ready' && item.magnetId && releaseLanguageRank(item.sourceTitle) < 2)
      .filter((item) => !activeProvisions.has(item.lookupPath))
      .filter((item) => Date.now() - Date.parse(item.vfLastCheckedAt || 0) >= vfUpgradeIntervalMs)
      .sort((left, right) => Date.parse(left.vfLastCheckedAt || 0) - Date.parse(right.vfLastCheckedAt || 0));
    let upgraded = 0;
    let checked = 0;
    const checkedSeriesGroups = new Set();
    for (const current of candidates) {
      if (upgraded >= vfUpgradeBatchSize || checked >= 12) break;
      const parts = current.lookupPath.split('/');
      const isMovie = parts[0] === 'movie';
      const tmdbId = Number(parts[1]);
      const season = Number(parts[2]);
      const episode = Number(parts[3]);
      if (!isMovie) {
        const group = `${tmdbId}:${season}`;
        if (checkedSeriesGroups.has(group)) continue;
        checkedSeriesGroups.add(group);
      }
      const [metadata, externalIds] = await Promise.all([
        tmdbJson(isMovie ? `/movie/${tmdbId}` : `/tv/${tmdbId}`),
        tmdbJson(isMovie ? `/movie/${tmdbId}/external_ids` : `/tv/${tmdbId}/external_ids`),
      ]);
      const imdbId = externalIds.imdb_id;
      if (!imdbId) continue;
      checked += 1;
      const releases = await cometReleases({ mediaType: isMovie ? 'movie' : 'series', imdbId, season, episode });
      const frenchRelease = rankedReleases(releases, !isMovie)
        .find((release) => release.languageRank >= 2 && releaseInfoHash(release) !== current.sourceHash);
      await updateProvision(current.lookupPath, { vfLastCheckedAt: new Date().toISOString() });
      if (!frenchRelease) continue;
      console.log(`Mise à niveau VF trouvée pour ${current.lookupPath}: ${frenchRelease.title}`);
      if (await replaceReadyProvisionWithFrench(current, frenchRelease, metadata)) upgraded += 1;
    }
    if (checked || upgraded) console.log(`Contrôle VF terminé: ${checked} vérifié(s), ${upgraded} mise(s) à niveau lancée(s).`);
  } catch (error) {
    console.error(`Contrôle automatique VF: ${error.message}`);
  } finally {
    vfUpgradeScanRunning = false;
  }
};

const directPlayEnabled = process.env.DIRECT_PLAY_ENABLED !== 'false';
const edgeCacheRoot = process.env.EDGE_CACHE_ROOT || '/state/edge-cache';
const edgeCacheHeadBytes = Math.max(4, Math.min(128, Number(process.env.EDGE_CACHE_HEAD_MB) || 64)) * 1024 ** 2;
const edgeCacheTailBytes = Math.max(2, Math.min(64, Number(process.env.EDGE_CACHE_TAIL_MB) || 16)) * 1024 ** 2;
const edgeCacheMaxEntries = Math.max(5, Math.min(500, Number(process.env.EDGE_CACHE_MAX_ENTRIES) || 100));
const edgeCacheWarms = new Map();

const provisionCandidate = (lookupPath, requestedSourceId = '') => {
  const provision = provisions.get(lookupPath);
  const candidates = provisionSourceCandidates(provision);
  return candidates.find((item) => item.id === requestedSourceId)
    || candidates.find((item) => item.id === provision?.activeSourceId)
    || candidates[0];
};

const unlockProvisionCandidate = async (candidate) => {
  if (!candidate?.magnetId || !Number.isInteger(candidate.fileIndex)) {
    throw new Error('Source média inconnue.');
  }
  const provider = candidate.provider || 'alldebrid';
  const cacheKey = `${provider}:${candidate.magnetId}:${candidate.fileIndex}`;
  const unlockMedia = async () => {
    let result;
    if (provider === 'realdebrid') {
      const torrent = await realDebridRequest(`/torrents/info/${encodeURIComponent(candidate.magnetId)}`);
      const file = realDebridVideoFiles(torrent).find((item) => item.fileIndex === candidate.fileIndex);
      if (!file) throw new Error('Fichier Real-Debrid introuvable.');
      const data = await realDebridRequest('/unrestrict/link', { method: 'POST', fields: { link: file.link } });
      result = { url: data.download, filename: data.filename || file.name, size: Number(data.filesize) || file.size, expiresAt: Date.now() + 20 * 60_000 };
    } else {
      const status = await magnetStatus(candidate.magnetId);
      const file = videoFiles(status).find((item) => item.fileIndex === candidate.fileIndex);
      if (!file) throw new Error('Fichier AllDebrid introuvable.');
      const data = await allDebridRequest('/v4/link/unlock', { link: file.link });
      result = { url: data.link, filename: data.filename || file.name, size: Number(data.filesize) || file.size, expiresAt: Date.now() + 20 * 60_000 };
    }
    unlockedLinks.set(cacheKey, result);
    return result;
  };
  let unlocked = unlockedLinks.get(cacheKey);
  if (!unlocked || unlocked.expiresAt < Date.now()) {
    unlocked = await unlockMedia();
  }
  return { ...unlocked, cacheKey, candidate };
};

const edgeCachePaths = (cacheKey) => {
  const directory = join(edgeCacheRoot, createHash('sha256').update(cacheKey).digest('hex'));
  return { directory, head: join(directory, 'head.bin'), tail: join(directory, 'tail.bin'), metadata: join(directory, 'metadata.json') };
};

const trimEdgeCache = async () => {
  const entries = await readdir(edgeCacheRoot, { withFileTypes: true }).catch(() => []);
  const directories = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const path = join(edgeCacheRoot, entry.name);
    const info = await stat(path).catch(() => null);
    return { path, mtime: info?.mtimeMs || 0 };
  }));
  directories.sort((left, right) => right.mtime - left.mtime);
  await Promise.all(directories.slice(edgeCacheMaxEntries).map((entry) => rm(entry.path, { recursive: true, force: true })));
};

const warmEdgeCache = async (lookupPath, requestedSourceId = '') => {
  const candidate = provisionCandidate(lookupPath, requestedSourceId);
  if (!candidate) return null;
  const warmKey = `${lookupPath}:${candidate.id || requestedSourceId}`;
  if (edgeCacheWarms.has(warmKey)) return edgeCacheWarms.get(warmKey);
  const task = (async () => {
    const unlocked = await unlockProvisionCandidate(candidate);
    const size = Math.max(0, Number(unlocked.size) || Number(candidate.size) || 0);
    if (size < 1024 ** 2) return null;
    const paths = edgeCachePaths(unlocked.cacheKey);
    const existing = await readFile(paths.metadata, 'utf8').then(JSON.parse).catch(() => null);
    if (existing?.size === size && existing?.headBytes > 0 && existing?.tailBytes > 0) return { ...existing, ...paths };
    await mkdir(paths.directory, { recursive: true });
    const headBytes = Math.min(edgeCacheHeadBytes, size);
    const tailBytes = Math.min(edgeCacheTailBytes, Math.max(0, size - headBytes));
    const fetchRange = async (start, end) => {
      const result = await fetch(unlocked.url, { headers: { Range: `bytes=${start}-${end}` }, redirect: 'follow', signal: AbortSignal.timeout(60_000) });
      if (result.status !== 206) throw new Error(`La source ne prend pas en charge le cache partiel (${result.status}).`);
      return Buffer.from(await result.arrayBuffer());
    };
    const [head, tail] = await Promise.all([
      fetchRange(0, headBytes - 1),
      tailBytes > 0 ? fetchRange(size - tailBytes, size - 1) : Promise.resolve(Buffer.alloc(0)),
    ]);
    if (head.length !== headBytes || tail.length !== tailBytes) throw new Error('Cache partiel incomplet.');
    await writeFile(`${paths.head}.tmp`, head);
    await rename(`${paths.head}.tmp`, paths.head);
    await writeFile(`${paths.tail}.tmp`, tail);
    await rename(`${paths.tail}.tmp`, paths.tail);
    const metadata = { size, headBytes, tailBytes, warmedAt: new Date().toISOString() };
    await writeFile(paths.metadata, JSON.stringify(metadata));
    await trimEdgeCache();
    return { ...metadata, ...paths };
  })().catch((error) => {
    console.warn(`Cache rapide ${lookupPath}: ${error.message}`);
    return null;
  }).finally(() => edgeCacheWarms.delete(warmKey));
  edgeCacheWarms.set(warmKey, task);
  return task;
};

const serveEdgeCacheRange = async (request, response, unlocked) => {
  const match = /^bytes=(\d+)-(\d+)$/.exec(String(request.headers.range || ''));
  if (!match) return false;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return false;
  const paths = edgeCachePaths(unlocked.cacheKey);
  const metadata = await readFile(paths.metadata, 'utf8').then(JSON.parse).catch(() => null);
  if (!metadata || end >= metadata.size) return false;
  let buffer;
  if (start < metadata.headBytes && end < metadata.headBytes) {
    buffer = (await readFile(paths.head)).subarray(start, end + 1);
  } else if (start >= metadata.size - metadata.tailBytes) {
    const offset = start - (metadata.size - metadata.tailBytes);
    buffer = (await readFile(paths.tail)).subarray(offset, offset + (end - start + 1));
  } else return false;
  response.writeHead(206, {
    'Content-Type': /\.m4v?$|\.mp4$/i.test(unlocked.filename || '') ? 'video/mp4' : 'application/octet-stream',
    'Content-Length': buffer.length,
    'Content-Range': `bytes ${start}-${end}/${metadata.size}`,
    'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', 'Access-Control-Allow-Origin': '*',
  });
  if (request.method === 'HEAD') return response.end();
  response.end(buffer);
  return true;
};

const proxyDebridMedia = async (request, response, forced = null) => {
  const requestUrl = new URL(request.url, 'http://local');
  const lookupPath = forced?.lookupPath || requestUrl.searchParams.get('lookup') || '';
  const requestedSourceId = forced?.sourceId || String(requestUrl.searchParams.get('source') || '');
  const candidate = provisionCandidate(lookupPath, requestedSourceId);
  if (!candidate) {
    response.writeHead(404, { 'Content-Type': 'application/json' });
    return response.end(JSON.stringify({ error: 'Source média inconnue.' }));
  }
  let unlocked = await unlockProvisionCandidate(candidate);
  if (await serveEdgeCacheRange(request, response, unlocked)) return undefined;
  const headers = {};
  if (request.headers.range) headers.Range = request.headers.range;
  let upstream = await fetch(unlocked.url, { method: request.method, headers, redirect: 'follow' });
  if (!upstream.ok && upstream.status !== 206) {
    unlockedLinks.delete(unlocked.cacheKey);
    unlocked = await unlockProvisionCandidate(candidate);
    upstream = await fetch(unlocked.url, { method: request.method, headers, redirect: 'follow' });
  }
  if (!upstream.ok && upstream.status !== 206) throw new Error(`Flux média indisponible (${upstream.status}).`);
  const forwarded = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
  const responseHeaders = Object.fromEntries(forwarded.map((name) => [name, upstream.headers.get(name)]).filter(([, value]) => value));
  if (forced) responseHeaders['content-type'] = 'video/mp4';
  responseHeaders['accept-ranges'] = 'bytes';
  responseHeaders['cache-control'] = 'private, max-age=60';
  responseHeaders['access-control-allow-origin'] = '*';
  response.writeHead(upstream.status, responseHeaders);
  if (request.method === 'HEAD' || !upstream.body) return response.end();
  const stream = Readable.fromWeb(upstream.body);
  const expectedLength = Number(upstream.headers.get('content-length')) || 0;
  let receivedLength = 0;
  let completed = false;
  stream.on('data', (chunk) => { receivedLength += chunk.length; });
  stream.on('end', () => {
    completed = true;
    if (expectedLength && receivedLength < expectedLength) unlockedLinks.delete(unlocked.cacheKey);
  });
  stream.on('error', (error) => {
    unlockedLinks.delete(unlocked.cacheKey);
    if (error.name !== 'AbortError' && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error(`Lecture du flux interrompue: ${error.message}`);
    if (!response.destroyed) response.destroy(error);
  });
  response.on('close', () => {
    if (!completed && !response.writableEnded) unlockedLinks.delete(unlocked.cacheKey);
    if (!stream.destroyed) stream.destroy();
  });
  return stream.pipe(response);
};

const directPlayProfile = (candidate, inspection) => {
  const track = inspection?.tracks?.[0];
  const extension = extname(String(candidate?.fileName || candidate?.name || '')).toLowerCase();
  const mp4Container = ['.mp4', '.m4v'].includes(extension) || /(?:^|,)mov(?:,|$)|(?:^|,)mp4(?:,|$)/.test(inspection?.profile?.formatName || '');
  const frenchAudio = ['fre', 'fra', 'fr', 'fr-fr', 'fr-ca'].includes(String(track?.language || '').toLowerCase());
  const compatible = directPlayEnabled && mp4Container
    && inspection?.profile?.videoCodec === 'h264'
    && track?.codec === 'aac' && track.channels > 0 && track.channels <= 2
    && track.sourceIndex === 1 && frenchAudio;
  return compatible ? {
    videoCodec: 'h264', audioCodec: 'aac', container: 'mp4', duration: inspection.profile.duration,
    width: inspection.profile.width, height: inspection.profile.height,
  } : null;
};

const prepareDirectSource = async (lookupPath) => {
  if (!directPlayEnabled) return null;
  let provision = provisions.get(lookupPath);
  const candidates = provisionSourceCandidates(provision);
  const ordered = [
    candidates.find((candidate) => candidate.id === provision?.activeSourceId),
    ...candidates.filter((candidate) => candidate.id !== provision?.activeSourceId),
  ].filter(Boolean);
  if (!ordered.length) return null;
  if (provision?.preparedSourceId && provision?.preparedInspection) {
    warmEdgeCache(lookupPath, provision.preparedSourceId);
    return provision.directProfile || null;
  }
  let lastError = null;
  for (const candidate of ordered) {
    const source = `http://127.0.0.1:8788/media/source?lookup=${encodeURIComponent(lookupPath)}&source=${encodeURIComponent(candidate.id || '')}`;
    try {
      // Validate the source while the detail page is open, before the viewer
      // presses Play. This prevents a slow or broken debrid probe from being
      // paid on the critical first-frame path.
      const inspection = await inspectMedia(source, 12_000);
      provision = activateProvisionSource(lookupPath, provisions.get(lookupPath), candidate);
      const profile = directPlayProfile(candidate, inspection);
      await updateProvision(lookupPath, {
        preparedSourceId: candidate.id, preparedInspection: inspection,
        sourcePreparedAt: new Date().toISOString(), sourcePrepareError: null,
        directSourceId: profile ? candidate.id : null, directProfile: profile,
        directPreparedAt: profile ? new Date().toISOString() : null,
      });
      warmEdgeCache(lookupPath, candidate.id);
      return profile;
    } catch (error) {
      lastError = error;
      const current = provisions.get(lookupPath);
      await updateProvision(lookupPath, {
        sourceCandidates: provisionSourceCandidates(current).map((item) => item.id === candidate.id
          ? { ...item, state: 'failed', lastError: error.message, failedAt: new Date().toISOString() }
          : item),
        sourcePrepareError: error.message,
      });
    }
  }
  if (lastError) throw lastError;
  return null;
};

const liveHlsRoot = process.env.LIVE_HLS_ROOT || '/state/live-hls';
const liveSessions = new Map();
const liveSessionByLookup = new Map();
const liveSigningKey = process.env.MEDIA_ORIGIN_SIGNING_KEY || process.env.R2_IMPORTER_PASSWORD;
const livePublicUrl = String(process.env.MEDIA_ORIGIN_PUBLIC_URL || 'http://127.0.0.1:8788').replace(/\/$/, '');
const liveSessionTtlSeconds = Math.max(900, Number(process.env.LIVE_SESSION_TTL_SECONDS) || 12 * 60 * 60);
const liveFailureCooldownMs = Math.max(30_000, Number(process.env.LIVE_FAILURE_COOLDOWN_MS) || 2 * 60_000);
const liveFirstFrameTimeoutSeconds = Math.max(15, Number(process.env.LIVE_FIRST_FRAME_TIMEOUT_SECONDS) || 45);
const liveReadySegments = Math.max(1, Math.min(20, Number(process.env.LIVE_READY_SEGMENTS) || 1));
const liveProgressStallSeconds = Math.max(10, Number(process.env.LIVE_PROGRESS_STALL_SECONDS) || 18);
const r2PauseAtInteractiveStreams = Math.max(1, Math.min(2, Number(process.env.R2_PAUSE_AT_INTERACTIVE_STREAMS) || 1));
let liveTranscodesRunning = 0;
const liveTranscodeQueue = [];

const interactiveLiveTranscodes = () => [...liveSessions.values()].filter((session) => (
  !session.backgroundOnly
  && Number(session.viewers || 0) > 0
  && !['failed'].includes(session.status)
)).length;

const backgroundProcessingPaused = () => [...activeBackgroundProcesses.values()].some((process) => process.paused);

const registerBackgroundProcess = (child, metadata) => {
  const tracked = { child, paused: false, ...metadata };
  activeBackgroundProcesses.set(child.pid, tracked);
  child.once('close', () => {
    activeBackgroundProcesses.delete(child.pid);
    updateBackgroundTranscodeScheduling();
  });
  updateBackgroundTranscodeScheduling();
};

const updateBackgroundTranscodeScheduling = () => {
  const shouldPause = interactiveLiveTranscodes() >= r2PauseAtInteractiveStreams;
  for (const [pid, tracked] of activeBackgroundProcesses) {
    const { child } = tracked;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      activeBackgroundProcesses.delete(pid);
      continue;
    }
    if (shouldPause && !tracked.paused) {
      child.kill('SIGSTOP');
      tracked.paused = true;
    } else if (!shouldPause && tracked.paused) {
      child.kill('SIGCONT');
      tracked.paused = false;
    }
  }
  queueMicrotask(drainR2Lanes);
};

const liveSignature = (path, expires) => createHmac('sha256', liveSigningKey).update(`${path}\n${expires}`).digest('base64url');
const signedLiveUrl = (sessionId, name, expires = Math.floor(Date.now() / 1000) + liveSessionTtlSeconds) => {
  const path = `/live/${sessionId}/${name}`;
  return `${livePublicUrl}${path}?expires=${expires}&signature=${liveSignature(path, expires)}`;
};
const signedDirectUrl = (sessionId, expires = Math.floor(Date.now() / 1000) + liveSessionTtlSeconds) => {
  const path = `/direct/${sessionId}/media.mp4`;
  return `${livePublicUrl}${path}?expires=${expires}&signature=${liveSignature(path, expires)}`;
};
const validLiveSignature = (path, expires, signature) => {
  if (!Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000) || !signature) return false;
  const expected = Buffer.from(liveSignature(path, expires));
  const received = Buffer.from(String(signature));
  return received.length === expected.length && timingSafeEqual(received, expected);
};
const liveServiceAuthenticated = (request) => {
  const received = Buffer.from(String(request.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(String(process.env.MEDIA_ORIGIN_TOKEN || process.env.R2_IMPORTER_PASSWORD));
  return received.length === expected.length && timingSafeEqual(received, expected);
};

const liveSessionPayload = (session) => {
  const provision = provisions.get(session.lookupPath);
  const bufferedSeconds = Math.max(0, Number(session.bufferedDuration) || 0);
  const targetBufferSeconds = Math.max(4, Number(session.targetBufferSeconds) || liveReadySegments * 2);
  const queuePosition = session.status === 'queued' ? Math.max(1, liveTranscodeQueue.indexOf(session) + 1) : 0;
  const phase = session.status === 'queued' ? 'queued'
    : session.status === 'preparing' && !session.probeCompletedAt ? 'probing'
      : session.status === 'preparing' ? 'buffering' : session.status;
  const progress = phase === 'buffering'
    ? bufferedSeconds > 0 ? Math.min(95, Math.max(10, Math.round((bufferedSeconds / targetBufferSeconds) * 95))) : 10
    : phase === 'probing' ? 8 : phase === 'queued' ? 3 : 100;
  const etaSeconds = phase === 'buffering' && Number(session.encodingSpeed) > 0
    ? Math.max(1, Math.ceil((targetBufferSeconds - bufferedSeconds) / Number(session.encodingSpeed))) : null;
  const message = phase === 'queued'
    ? `En attente du moteur vidéo${queuePosition ? ` — position ${queuePosition}` : ''}.`
    : phase === 'probing' ? 'Vidéo trouvée, vérification du format et de la piste française…'
      : phase === 'buffering' ? 'La vidéo est presque prête…'
        : session.status === 'failed' ? 'La source vidéo a rencontré un problème. Nouvelle tentative automatique en cours.' : '';
  return ({
  available: session.status === 'live_ready' || session.status === 'complete',
  provider: 'origin', deliveryMode: session.deliveryMode || 'temporary_hls', quality: session.quality || 'source', attemptId: session.attemptId,
  sessionId: session.id,
  state: session.status, phase, lookupPath: session.lookupPath,
  streamUrl: session.status === 'live_ready' || session.status === 'complete'
    ? session.deliveryMode === 'direct_range' ? signedDirectUrl(session.id) : signedLiveUrl(session.id, 'index.m3u8')
    : null,
  duration: Number(session.duration) || 0,
  startOffset: Number(session.startOffset) || 0,
  expiresAt: new Date((Math.floor(Date.now() / 1000) + liveSessionTtlSeconds) * 1000).toISOString(),
  audioTracks: session.audioTracks || [], subtitleTracks: [], seekable: session.deliveryMode === 'direct_range' || (session.status === 'complete' && session.startOffset === 0),
  encodingSpeed: session.encodingSpeed || null,
  queuePosition, bufferedSeconds, targetBufferSeconds,
  encodedSeconds: Math.max(bufferedSeconds, Number(session.encodedSeconds) || 0),
  bytesProcessed: Math.max(0, Number(session.bytesProcessed) || 0),
  heartbeatAt: session.progressHeartbeatAt || session.updatedAt || session.createdAt,
  progress, progressMode: bufferedSeconds > 0 ? 'measured' : 'indeterminate',
  message, etaSeconds, etaKind: etaSeconds === null ? null : 'calculated',
  sourceId: session.sourceId || provision?.activeSourceId || null,
  sources: provisionSourceCandidates(provision).map((candidate) => publicSource(candidate, session.sourceId || provision?.activeSourceId)),
  sourcesDiscovering: multiSourceDiscoveries.has(session.lookupPath),
  error: session.status === 'failed' ? 'La source vidéo a rencontré un problème. Une nouvelle tentative sera possible automatiquement.' : null,
  retryAfterSeconds: session.status === 'failed'
    ? Math.max(0, Math.ceil((liveFailureCooldownMs - (Date.now() - Date.parse(session.failedAt || session.createdAt))) / 1000))
    : 0,
  });
};

const publishLiveSessionToR2 = async (session) => {
  const objectPrefix = `hls/${session.lookupPath}`;
  const title = provisions.get(session.lookupPath)?.title || session.lookupPath;
  if (r2HlsLayout === 'byterange-fmp4') {
    scheduleR2Encoding(session.lookupPath, title, false, 0, '720p');
    return;
  }
  const workingDirectory = await mkdtemp(join(tmpdir(), 'weflix-live-publish-'));
  try {
    await run('rclone', ['sync', session.directory, `WEFLIXR2:${process.env.R2_BUCKET}/${objectPrefix}/720p/video`], { env: rcloneEnv });
    const masterPath = join(workingDirectory, 'index.m3u8');
    await writeFile(masterPath, '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-STREAM-INF:BANDWIDTH=2400000,AVERAGE-BANDWIDTH=1900000,RESOLUTION=1280x720\n720p/video/index.m3u8\n');
    await run('rclone', ['copyto', masterPath, `WEFLIXR2:${process.env.R2_BUCKET}/${objectPrefix}/index.m3u8`], { env: rcloneEnv });
    const catalogPath = join(workingDirectory, 'catalog.json');
    await writeFile(catalogPath, `${JSON.stringify({
      schemaVersion: 2, key: `${objectPrefix}/index.m3u8`, title,
      duration: Number(session.duration) || 0, format: 'hls', qualities: ['720p'],
      audioTracks: session.audioTracks || [], subtitleTracks: [], updatedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await run('rclone', ['copyto', catalogPath, `WEFLIXR2:${process.env.R2_BUCKET}/catalog/${session.lookupPath}.json`], { env: rcloneEnv });
    const publishedAt = new Date().toISOString();
    await updateProvision(session.lookupPath, {
      availabilityState: 'r2_ready', r2ReadyAt: publishedAt, r2720pReadyAt: publishedAt,
      r2RefreshRequired: false, livePublishedToR2At: publishedAt,
    });
    await cancelQueuedR2Encoding(session.lookupPath, '720p');
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
};

const sourceFailureNeedsReplacement = (error) => /ffprobe|invalid data|flux média indisponible|fetch failed|http (?:4\d\d|5\d\d)|502|aucune progression|source.*(?:invalide|indisponible)/i
  .test(String(error?.message || error || ''));

const reprovisionBrokenLiveSource = async (session, error) => {
  if (session.startOffset !== 0 || provisions.get(session.lookupPath)?.liveAttemptId !== session.attemptId) return false;
  const [kind, mediaId, season, episode] = session.lookupPath.split('/');
  await cancelQueuedR2Encoding(session.lookupPath, '720p');
  session.preempted = true;
  liveSessions.delete(session.id);
  if (liveSessionByLookup.get(session.sessionKey) === session.id) liveSessionByLookup.delete(session.sessionKey);
  startProvision({
    mediaType: kind === 'episode' ? 'tv' : 'movie', mediaId: Number(mediaId),
    season: Number(season) || undefined, episode: Number(episode) || undefined,
    force: true,
  });
  console.warn(`Source directe remplacée automatiquement pour ${session.lookupPath}: ${error.message}`);
  return true;
};

const failoverBrokenLiveSource = async (session, error) => {
  if (session.startOffset !== 0) return false;
  const provision = provisions.get(session.lookupPath);
  const candidates = provisionSourceCandidates(provision);
  const next = candidates.find((candidate) => candidate.id !== session.sourceId && candidate.state !== 'failed');
  if (!next) return false;
  const markedCandidates = candidates.map((candidate) => candidate.id === session.sourceId
    ? { ...candidate, state: 'failed', lastError: error.message, failedAt: new Date().toISOString() }
    : candidate);
  const marked = { ...provision, sourceCandidates: markedCandidates };
  provisions.set(session.lookupPath, marked);
  const updated = activateProvisionSource(session.lookupPath, marked, next);
  session.preempted = true;
  liveSessions.delete(session.id);
  if (liveSessionByLookup.get(session.sessionKey) === session.id) liveSessionByLookup.delete(session.sessionKey);
  await updateProvision(session.lookupPath, {
    ...updated, status: 'ready', availabilityState: 'source_ready', stage: 'ready',
    progress: 100, liveError: null, liveFailedAt: null,
    message: 'La source de secours est prête à prendre le relais.',
  });
  scheduleR2Encoding(session.lookupPath, updated.title || session.lookupPath, false, 0, '720p');
  console.warn(`Basculement automatique ${session.lookupPath}: ${session.sourceId} -> ${next.id} (${error.message})`);
  return true;
};

const waitForLivePlaylist = async (session, child) => {
  const playlistPath = join(session.directory, 'index.m3u8');
  for (let attempt = 0; attempt < liveFirstFrameTimeoutSeconds; attempt += 1) {
    if (session.status === 'failed' || session.process !== child || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('La préparation du flux s’est arrêtée avant les premières images.');
    }
    try {
      const playlist = await readFile(playlistPath, 'utf8');
      session.bufferedDuration = [...playlist.matchAll(/^#EXTINF:([\d.]+)/gm)].reduce((total, match) => total + Number(match[1]), 0);
      session.progressHeartbeatAt = new Date().toISOString();
      if ((playlist.match(/^#EXTINF:/gm) || []).length >= liveReadySegments) {
        if (session.status !== 'preparing' || session.process !== child || child.exitCode !== null || child.signalCode !== null) {
          throw new Error('Cette tentative de lecture n’est plus active.');
        }
        if (session.startOffset === 0 && provisions.get(session.lookupPath)?.liveAttemptId !== session.attemptId) {
          throw new Error('Une tentative de lecture plus récente a remplacé celle-ci.');
        }
        session.status = 'live_ready';
        session.firstFrameReadyAt = new Date().toISOString();
        if (session.startOffset === 0) {
          await updateProvision(session.lookupPath, {
            availabilityState: 'live_ready', liveAttemptId: session.attemptId,
            liveReadyAt: session.firstFrameReadyAt, quality: '720p', seekable: false,
          });
        }
        return;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      /* ffmpeg has not published its first playlist yet */
    }
    await sleep(1_000);
  }
  throw new Error('Les premières images ne sont pas arrivées dans le délai prévu.');
};

const drainLiveTranscodes = () => {
  const maximum = Math.max(1, Math.min(2, Number(process.env.LIVE_TRANSCODE_CONCURRENCY) || 1));
  // A film already started may continue to completion so it becomes an R2
  // cache hit for the next viewer. It remains preemptible: an interactive
  // session always reclaims a slot immediately.
  if (liveTranscodeQueue.length && liveTranscodesRunning >= maximum) {
    const backgroundSession = [...liveSessions.values()].find((candidate) => (
      candidate.backgroundOnly
      && candidate.process?.exitCode === null
      && candidate.process?.signalCode === null
      && !['complete', 'failed'].includes(candidate.status)
    ));
    if (backgroundSession) {
      backgroundSession.preempted = true;
      backgroundSession.process.kill('SIGTERM');
    }
  }
  while (liveTranscodesRunning < maximum && liveTranscodeQueue.length) {
    liveTranscodeQueue.sort((left, right) => Number(left.backgroundOnly) - Number(right.backgroundOnly) || Date.parse(left.createdAt) - Date.parse(right.createdAt));
    const session = liveTranscodeQueue.shift();
    if (!session || session.status !== 'queued') continue;
    liveTranscodesRunning += 1;
    session.status = 'preparing';
    updateBackgroundTranscodeScheduling();
    (async () => {
      await mkdir(session.directory, { recursive: true });
      const source = `http://r2-importer:8788/media/source?lookup=${encodeURIComponent(session.lookupPath)}&source=${encodeURIComponent(session.sourceId || '')}`;
      const prepared = provisions.get(session.lookupPath);
      const inspection = prepared?.preparedSourceId === session.sourceId && prepared?.preparedInspection
        ? prepared.preparedInspection
        : await inspectMedia(source);
      const { tracks, profile } = inspection;
      session.probeCompletedAt = new Date().toISOString();
      session.progressHeartbeatAt = session.probeCompletedAt;
      const track = tracks[0];
      // The event playlist initially contains only a few generated segments.
      // Keep the source duration separately so the custom player immediately
      // renders the full-film timeline instead of a 6-second HLS bar.
      session.duration = profile.duration;
      session.audioTracks = [{ index: 0, language: track.language, title: track.title, default: true }];
      const candidate = provisionCandidate(session.lookupPath, session.sourceId);
      const directProfile = directPlayProfile(candidate, { tracks, profile });
      if (directProfile) {
        session.deliveryMode = 'direct_range';
        session.quality = profile.height >= 1000 ? '1080p directe' : '720p directe';
        session.status = 'live_ready';
        session.firstFrameReadyAt = new Date().toISOString();
        session.bufferedDuration = 0;
        session.targetBufferSeconds = 0;
        await updateProvision(session.lookupPath, {
          availabilityState: 'source_ready', directSourceId: candidate.id, directProfile,
          directPreparedAt: session.firstFrameReadyAt, liveReadyAt: session.firstFrameReadyAt,
        });
        warmEdgeCache(session.lookupPath, candidate.id);
        return;
      }
      const canRemuxVideo = profile.videoCodec === 'h264' && profile.height > 0 && profile.height <= 1080;
      const canCopyAudio = track.codec === 'aac' && track.channels > 0 && track.channels <= 2;
      session.deliveryMode = canRemuxVideo ? 'remux_hls' : 'transcoded_hls';
      session.quality = canRemuxVideo ? (profile.height >= 1000 ? '1080p source' : '720p source') : '480p temporaire';
      session.targetBufferSeconds = liveReadySegments * 2;
      const args = [
        '-hide_banner', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:2', '-stats_period', '1', '-y',
        ...(session.startOffset > 0 ? ['-ss', String(session.startOffset)] : []),
        '-i', source,
        '-map', '0:v:0', '-map', `0:${track.sourceIndex}`,
        ...(canRemuxVideo
          ? ['-c:v', 'copy']
          : ['-vf', "scale=-2:'min(480,ih)'", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25', '-maxrate', '1200k', '-bufsize', '2400k', '-pix_fmt', 'yuv420p', '-threads', '2']),
        ...(canCopyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k', '-ac', '2']),
        '-force_key_frames', 'expr:gte(t,n_forced*2)', '-hls_time', '2', '-hls_list_size', '0',
        '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments+temp_file',
        '-hls_segment_filename', join(session.directory, 'segment-%05d.ts'), join(session.directory, 'index.m3u8'),
      ];
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      session.process = child;
      session.progressHeartbeatAt = new Date().toISOString();
      let progressBuffer = '';
      child.stderr.on('data', (chunk) => {
        progressBuffer += String(chunk);
        const lines = progressBuffer.split(/\r?\n/);
        progressBuffer = lines.pop() || '';
        for (const line of lines) {
          const separator = line.indexOf('=');
          if (separator < 1) continue;
          const key = line.slice(0, separator);
          const value = line.slice(separator + 1).trim();
          if (key === 'speed') session.encodingSpeed = Number(value.replace(/x$/, '')) || session.encodingSpeed;
          if (key === 'out_time_us' || key === 'out_time_ms') session.encodedSeconds = Math.max(Number(session.encodedSeconds) || 0, (Number(value) || 0) / 1_000_000);
          if (key === 'total_size') session.bytesProcessed = Number(value) || session.bytesProcessed;
          if (['speed', 'out_time_us', 'out_time_ms', 'total_size', 'progress'].includes(key)) session.progressHeartbeatAt = new Date().toISOString();
        }
      });
      const stallTimer = setInterval(() => {
        if (Date.now() - Date.parse(session.progressHeartbeatAt || session.probeCompletedAt) > liveProgressStallSeconds * 1000) {
          session.stallDetected = true;
          child.kill('SIGKILL');
        }
      }, 2_000);
      const childCompletion = new Promise((done, reject) => {
        child.once('error', reject);
        child.once('close', (code) => {
          clearInterval(stallTimer);
          code === 0 ? done() : reject(new Error(session.stallDetected
            ? `Aucune progression vidéo depuis ${liveProgressStallSeconds} secondes.`
            : `ffmpeg direct a quitté avec le code ${code}`));
        });
      });
      const firstResult = await Promise.race([
        waitForLivePlaylist(session, child).then(() => 'ready'),
        childCompletion.then(() => 'complete'),
      ]);
      if (firstResult === 'complete' && session.status !== 'live_ready') {
        throw new Error('Le flux s’est terminé sans produire assez de segments lisibles.');
      }
      await childCompletion;
      session.status = 'complete';
      session.completedAt = new Date().toISOString();
      const finalPlaylist = await readFile(join(session.directory, 'index.m3u8'), 'utf8');
      session.bufferedDuration = [...finalPlaylist.matchAll(/^#EXTINF:([\d.]+)/gm)].reduce((total, match) => total + Number(match[1]), 0);
      if (session.startOffset === 0) {
        session.duration = session.bufferedDuration;
        if (provisions.get(session.lookupPath)?.liveAttemptId === session.attemptId) {
          await updateProvision(session.lookupPath, { availabilityState: 'live_ready', seekable: true, liveCompletedAt: session.completedAt });
          await publishLiveSessionToR2(session);
        }
      }
    })().catch(async (error) => {
      session.status = 'failed';
      session.error = error.message;
      session.failedAt = new Date().toISOString();
      if (session.process?.exitCode === null && session.process?.signalCode === null) session.process.kill('SIGTERM');
      await rm(session.directory, { recursive: true, force: true }).catch(() => null);
      if (!session.preempted && await failoverBrokenLiveSource(session, error)) return;
      if (sourceFailureNeedsReplacement(error) && await reprovisionBrokenLiveSource(session, error)) return;
      if (!session.preempted && session.startOffset === 0 && provisions.get(session.lookupPath)?.liveAttemptId === session.attemptId) {
        await updateProvision(session.lookupPath, {
          availabilityState: 'live_failed', liveError: error.message, liveFailedAt: session.failedAt,
        });
        console.error(`Flux direct ${session.lookupPath}: ${error.message}`);
      } else {
        liveSessions.delete(session.id);
        if (liveSessionByLookup.get(session.sessionKey) === session.id) liveSessionByLookup.delete(session.sessionKey);
      }
    }).finally(() => {
      liveTranscodesRunning -= 1;
      updateBackgroundTranscodeScheduling();
      drainLiveTranscodes();
    });
  }
};

const activateProvisionSource = (lookupPath, provision, candidate) => {
  if (!candidate || candidate.id === provision.activeSourceId) return provision;
  const sourceCandidates = provisionSourceCandidates(provision).map((item) => ({
    ...item, state: item.id === candidate.id ? 'validated' : item.state,
  }));
  const updated = {
    ...provision,
    provider: candidate.provider, magnetId: candidate.magnetId, fileIndex: candidate.fileIndex,
    fileName: candidate.fileName, sourceTitle: candidate.sourceTitle, sourceHash: candidate.sourceHash,
    sourceSize: candidate.sourceSize, sourceCandidates, activeSourceId: candidate.id,
    activeSourceChangedAt: new Date().toISOString(),
  };
  provisions.set(lookupPath, updated);
  persistProvisionSnapshot();
  return updated;
};

const getOrCreateLiveSession = (lookupPath, requestedStart = 0, requestedSourceId = '') => {
  const startOffset = Math.max(0, Math.floor(Number(requestedStart) || 0));
  let provision = provisions.get(lookupPath);
  const candidates = provisionSourceCandidates(provision);
  if (candidates.length < multiSourceMaximum) queueMicrotask(() => discoverProvisionAlternatives(lookupPath));
  const requestedCandidate = candidates.find((candidate) => candidate.id === requestedSourceId && candidate.state !== 'failed');
  const activeCandidate = requestedCandidate
    || candidates.find((candidate) => candidate.id === provision?.activeSourceId && candidate.state !== 'failed')
    || candidates.find((candidate) => candidate.state !== 'failed');
  if (activeCandidate) provision = activateProvisionSource(lookupPath, provision, activeCandidate);
  const sourceId = activeCandidate?.id || provision?.activeSourceId || '';
  const sessionKey = `${lookupPath}@${startOffset}@${sourceId}`;
  const existingId = liveSessionByLookup.get(sessionKey);
  const existing = existingId ? liveSessions.get(existingId) : null;
  if (existing?.status === 'failed') {
    const failedFor = Date.now() - Date.parse(existing.failedAt || existing.createdAt);
    if (failedFor < liveFailureCooldownMs) return existing;
    liveSessions.delete(existing.id);
    if (liveSessionByLookup.get(sessionKey) === existing.id) liveSessionByLookup.delete(sessionKey);
    rm(existing.directory, { recursive: true, force: true }).catch(() => null);
  }
  if (existing && existing.status !== 'failed' && Date.now() - Date.parse(existing.createdAt) < liveSessionTtlSeconds * 1000) {
    // A session kept alive solely to fill R2 becomes interactive again as soon
    // as a viewer requests it. Do not increment a counter here: the same
    // client polls this endpoint while the first segments are being prepared.
    existing.backgroundOnly = false;
    existing.viewers = Math.max(1, Number(existing.viewers) || 0);
    existing.lastHeartbeatAt = new Date().toISOString();
    updateBackgroundTranscodeScheduling();
    return existing;
  }
  if (!provision?.magnetId || !['ready', 'source_ready', 'live_ready', 'r2_ready'].includes(String(provision.status))) return null;
  const id = randomUUID();
  const session = {
    id, lookupPath, sourceId, attemptId: randomUUID(), status: 'queued',
    startOffset, sessionKey,
    createdAt: new Date().toISOString(), lastHeartbeatAt: new Date().toISOString(), viewers: 1,
    directory: join(liveHlsRoot, id),
  };
  liveSessions.set(id, session);
  liveSessionByLookup.set(sessionKey, id);
  scheduleR2Encoding(lookupPath, provision.title || lookupPath, false, 0, '720p');
  const directReady = directPlayEnabled && provision.directProfile && provision.directSourceId === sourceId;
  if (directReady) {
    session.status = 'live_ready';
    session.deliveryMode = 'direct_range';
    session.duration = Number(provision.directProfile.duration) || 0;
    session.quality = Number(provision.directProfile.height) >= 1000 ? '1080p directe' : '720p directe';
    session.audioTracks = [{ index: 0, language: 'fre', title: 'Français', default: true }];
    session.firstFrameReadyAt = new Date().toISOString();
    warmEdgeCache(lookupPath, sourceId);
    return session;
  }
  if (startOffset === 0) {
    updateProvision(lookupPath, {
      availabilityState: 'preparing', liveStartedAt: session.createdAt,
      liveAttemptId: session.attemptId, liveError: null, liveFailedAt: null,
    }).catch((error) => console.error(`État direct ${lookupPath}: ${error.message}`));
  }
  liveTranscodeQueue.push(session);
  drainLiveTranscodes();
  return session;
};

const cleanupExpiredLiveSessions = async () => {
  const cutoff = Date.now() - liveSessionTtlSeconds * 1000;
  for (const [id, session] of liveSessions) {
    const idle = Date.now() - Date.parse(session.lastHeartbeatAt || session.createdAt);
    const abandoned = !session.backgroundOnly && !['complete', 'failed'].includes(session.status) && idle > 90_000;
    const failedExpired = session.status === 'failed' && Date.now() - Date.parse(session.failedAt || session.createdAt) >= liveFailureCooldownMs;
    if (!abandoned && !failedExpired && Date.parse(session.createdAt) > cutoff) continue;
    if (session.process && !session.process.killed) session.process.kill('SIGTERM');
    liveSessions.delete(id);
    if (liveSessionByLookup.get(session.sessionKey) === id) liveSessionByLookup.delete(session.sessionKey);
    await rm(session.directory, { recursive: true, force: true }).catch(() => null);
  }
  updateBackgroundTranscodeScheduling();
};

const serveLiveMedia = async (request, response, requestUrl) => {
  const match = /^\/live\/([a-f0-9-]+)\/([a-z0-9_.-]+)$/i.exec(requestUrl.pathname);
  if (!match || !validLiveSignature(requestUrl.pathname, Number(requestUrl.searchParams.get('expires')), requestUrl.searchParams.get('signature'))) {
    response.writeHead(401); return response.end();
  }
  const session = liveSessions.get(match[1]);
  if (!session) { response.writeHead(404); return response.end(); }
  const file = join(session.directory, match[2]);
  if (!file.startsWith(`${session.directory}/`)) { response.writeHead(400); return response.end(); }
  try {
    const info = await stat(file);
    let body = await readFile(file);
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': match[2].endsWith('.m3u8') ? 'no-store' : 'public, max-age=3600', 'Content-Length': info.size };
    if (match[2].endsWith('.m3u8')) {
      const expires = Number(requestUrl.searchParams.get('expires'));
      const playlist = body.toString('utf8').split(/\r?\n/).map((line) => line && !line.startsWith('#') ? `${line}?expires=${expires}&signature=${liveSignature(`/live/${session.id}/${line}`, expires)}` : line).join('\n');
      body = Buffer.from(playlist);
      headers['Content-Type'] = 'application/vnd.apple.mpegurl';
      headers['Content-Length'] = body.length;
    } else headers['Content-Type'] = 'video/mp2t';
    response.writeHead(200, headers);
    return request.method === 'HEAD' ? response.end() : response.end(body);
  } catch { response.writeHead(404); return response.end(); }
};

const serveDirectMedia = async (request, response, requestUrl) => {
  const match = /^\/direct\/([a-f0-9-]+)\/media\.mp4$/i.exec(requestUrl.pathname);
  if (!match || !validLiveSignature(requestUrl.pathname, Number(requestUrl.searchParams.get('expires')), requestUrl.searchParams.get('signature'))) {
    response.writeHead(401); return response.end();
  }
  const session = liveSessions.get(match[1]);
  if (!session || session.deliveryMode !== 'direct_range') {
    response.writeHead(404); return response.end();
  }
  session.lastHeartbeatAt = new Date().toISOString();
  return proxyDebridMedia(request, response, { lookupPath: session.lookupPath, sourceId: session.sourceId });
};

const triggerArrRefresh = async (category) => {
  const isSeries = category === 'sonarr';
  const baseUrl = process.env[isSeries ? 'SONARR_URL' : 'RADARR_URL'];
  const apiKey = process.env[isSeries ? 'SONARR_API_KEY' : 'RADARR_API_KEY'];
  if (!baseUrl || !apiKey) return;
  const response = await fetch(`${baseUrl}/api/v3/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({ name: 'RefreshMonitoredDownloads' }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${isSeries ? 'Sonarr' : 'Radarr'} refresh a répondu ${response.status}.`);
};

const replaceFailedTorrent = async (torrent) => {
  const isSeries = torrent.category === 'sonarr';
  const baseUrl = process.env[isSeries ? 'SONARR_URL' : 'RADARR_URL'];
  const apiKey = process.env[isSeries ? 'SONARR_API_KEY' : 'RADARR_API_KEY'];
  if (!baseUrl || !apiKey) return false;
  const queueResponse = await fetch(`${baseUrl}/api/v3/queue?pageSize=200&includeUnknown${isSeries ? 'Series' : 'Movie'}Items=true`, {
    headers: { 'X-Api-Key': apiKey },
    signal: AbortSignal.timeout(20_000),
  });
  if (!queueResponse.ok) throw new Error(`${isSeries ? 'Sonarr' : 'Radarr'} queue a répondu ${queueResponse.status}.`);
  const queue = await queueResponse.json();
  const item = (queue.records || []).find((record) => String(record.downloadId || '').toLowerCase() === String(torrent.hash || '').toLowerCase());
  if (!item) return false;
  const parameters = new URLSearchParams({
    removeFromClient: 'true',
    blocklist: 'true',
    skipRedownload: 'false',
    changeCategory: 'false',
  });
  const response = await fetch(`${baseUrl}/api/v3/queue/${item.id}?${parameters}`, {
    method: 'DELETE', headers: { 'X-Api-Key': apiKey }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${isSeries ? 'Sonarr' : 'Radarr'} rejet a répondu ${response.status}.`);
  console.log(`Source défectueuse bloquée, recherche de remplacement autorisée: ${torrent.name}`);
  return true;
};

const arrConfigurations = () => [
  { category: 'radarr', baseUrl: process.env.RADARR_URL, apiKey: process.env.RADARR_API_KEY, unknown: 'Movie' },
  { category: 'sonarr', baseUrl: process.env.SONARR_URL, apiKey: process.env.SONARR_API_KEY, unknown: 'Series' },
].filter((item) => item.baseUrl && item.apiKey);

const deleteQueueItem = async (configuration, item) => {
  const parameters = new URLSearchParams({ removeFromClient: 'true', blocklist: 'true', skipRedownload: 'false', changeCategory: 'false' });
  const response = await fetch(`${configuration.baseUrl}/api/v3/queue/${item.id}?${parameters}`, {
    method: 'DELETE', headers: { 'X-Api-Key': configuration.apiKey }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok && response.status !== 404) throw new Error(`${configuration.category} rejet queue a répondu ${response.status}.`);
};

const reconcileArrQueues = async (vortexHashes) => {
  for (const configuration of arrConfigurations()) {
    const queue = await arrJson(
      configuration.baseUrl,
      configuration.apiKey,
      `/api/v3/queue?pageSize=200&includeUnknown${configuration.unknown}Items=true`,
    );
    const warningCutoff = Date.now() - 2 * 60 * 1000;
    const candidates = (queue.records || []).filter((item) =>
      (item.status === 'warning'
        && /reporting an error/i.test(item.errorMessage || '')
        && Date.parse(item.added || 0) < warningCutoff)
      || (item.status === 'completed' && item.trackedDownloadStatus === 'warning')
      || (item.status === 'downloading'
        && Number(item.size || 0) === 0
        && item.downloadId
        && !vortexHashes.has(String(item.downloadId).toLowerCase()))
      || (configuration.category === 'radarr' && Number(item.size || 0) > 5 * 1024 ** 3),
    );
    const unique = [...new Map(candidates.map((item) => [String(item.downloadId || item.id).toLowerCase(), item])).values()];
    const pending = unique.filter((candidate) =>
      !acceleratorState.queues.includes(`${configuration.category}:${String(candidate.downloadId || candidate.id).toLowerCase()}`),
    ).slice(0, 10);
    for (const item of pending) {
      const stateId = `${configuration.category}:${String(item.downloadId || item.id).toLowerCase()}`;
      await deleteQueueItem(configuration, item);
      await rememberAccelerator('queues', stateId);
      console.log(`Téléchargement bloqué retiré et source blacklistée (${configuration.category}): ${item.title}`);
    }
  }
};

const reconcilePhantomGrabs = async (vortexHashes) => {
  for (const configuration of arrConfigurations()) {
    const [queue, history] = await Promise.all([
      arrJson(configuration.baseUrl, configuration.apiKey, `/api/v3/queue?pageSize=200&includeUnknown${configuration.unknown}Items=true`),
      arrJson(configuration.baseUrl, configuration.apiKey, '/api/v3/history?page=1&pageSize=200&sortKey=date&sortDirection=descending'),
    ]);
    const queueIds = new Set((queue.records || []).map((item) => String(item.downloadId || '').toLowerCase()).filter(Boolean));
    const records = history.records || [];
    const completedIds = new Set(records.filter((item) => item.eventType !== 'grabbed').map((item) => String(item.downloadId || '').toLowerCase()).filter(Boolean));
    const cutoff = Date.now() - 2 * 60 * 1000;
    const candidate = records.find((item) => {
      const downloadId = String(item.downloadId || '').toLowerCase();
      const stateId = `${configuration.category}:${item.id}`;
      return item.eventType === 'grabbed'
        && downloadId
        && Date.parse(item.date) < cutoff
        && Date.parse(item.date) > Date.now() - 48 * 60 * 60 * 1000
        && !queueIds.has(downloadId)
        && !vortexHashes.has(downloadId)
        && !completedIds.has(downloadId)
        && !acceleratorState.history.includes(stateId);
    });
    if (!candidate) continue;
    const response = await fetch(`${configuration.baseUrl}/api/v3/history/failed/${candidate.id}`, {
      method: 'POST', headers: { 'X-Api-Key': configuration.apiKey }, signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`${configuration.category} échec historique a répondu ${response.status}.`);
    await rememberAccelerator('history', `${configuration.category}:${candidate.id}`);
    console.log(`Grab fantôme déclaré en échec (${configuration.category}): ${candidate.sourceTitle || candidate.id}`);
  }
};

const startVortexAccelerator = async () => {
  const baseUrl = String(process.env.VORTEX_URL || 'http://vortex:8080').replace(/\/$/, '');
  const username = process.env.VORTEX_USER || 'admin';
  const password = process.env.VORTEX_PASSWORD || 'adminadmin';
  await loadAcceleratorState();
  const seenCompleted = new Set(acceleratorState.completed);
  const seenErrors = new Set(acceleratorState.errors);
  let running = false;
  let lastReconciliation = 0;

  const check = async () => {
    if (running) return;
    running = true;
    try {
      const login = await fetch(`${baseUrl}/api/v2/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username, password }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!login.ok) throw new Error(`Vortex login a répondu ${login.status}.`);
      const cookie = login.headers.get('set-cookie')?.split(';')[0] || '';
      const response = await fetch(`${baseUrl}/api/v2/torrents/info`, {
        headers: cookie ? { Cookie: cookie } : {}, signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`Vortex torrents a répondu ${response.status}.`);
      const torrents = await response.json();
      const completed = torrents.filter((torrent) => Number(torrent.progress) >= 1 && ['radarr', 'sonarr'].includes(torrent.category));
      const now = Math.floor(Date.now() / 1000);
      const failed = torrents.filter((torrent) => {
        if (!['radarr', 'sonarr'].includes(torrent.category)) return false;
        const staleDebridDownload = torrent.state === 'downloading'
          && !torrent.allDebridReady
          && Number(torrent.progress || 0) < 1
          && Number(torrent.dl_speed || 0) === 0
          && Number(torrent.added_on || now) < now - 10 * 60;
        return torrent.state === 'error' || staleDebridDownload;
      });
      for (const torrent of failed) {
        if (seenErrors.has(torrent.hash)) continue;
        const replaced = await replaceFailedTorrent(torrent);
        seenErrors.add(torrent.hash);
        await rememberAccelerator('errors', torrent.hash);
        if (replaced) break;
      }
      for (const torrent of completed) {
        if (seenCompleted.has(torrent.hash)) continue;
        seenCompleted.add(torrent.hash);
        await rememberAccelerator('completed', torrent.hash);
        console.log(`Vortex prêt, réveil immédiat de ${torrent.category}: ${torrent.name}`);
        await triggerArrRefresh(torrent.category);
      }
      if (Date.now() - lastReconciliation >= 30_000) {
        lastReconciliation = Date.now();
        const vortexHashes = new Set(torrents.map((torrent) => String(torrent.hash || '').toLowerCase()).filter(Boolean));
        await reconcileArrQueues(vortexHashes);
        await reconcilePhantomGrabs(vortexHashes);
      }
    } catch (error) {
      console.error(`Accélérateur Vortex: ${error.message}`);
    } finally {
      running = false;
    }
  };

  check();
  setInterval(check, Math.max(2000, Number(process.env.VORTEX_POLL_INTERVAL_MS) || 3000));
};

const existingCatalog = async () => {
  const raw = await capture('rclone', [
    'lsf', `WEFLIXR2:${process.env.R2_BUCKET}/catalog`, '--recursive', '--files-only',
  ], 120_000, { env: rcloneEnv });
  return new Set(raw.split(/\r?\n/).filter(Boolean).map((name) => name.replace(/\.json$/, '')));
};

const currentCatalogIndex = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weflix-catalog-index-'));
  const ready = new Set();
  try {
    await run('rclone', [
      'copy', `WEFLIXR2:${process.env.R2_BUCKET}/catalog`, directory,
      '--transfers', '16', '--checkers', '32',
    ], { env: rcloneEnv, timeoutMs: 120_000 });
    const visit = async (current, prefix = '') => {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const entryPath = join(current, entry.name);
        if (entry.isDirectory()) {
          await visit(entryPath, relative);
          continue;
        }
        if (!entry.name.endsWith('.json')) continue;
        try {
          const manifest = JSON.parse(await readFile(entryPath, 'utf8'));
          const lookupPath = relative.replace(/\.json$/, '');
          const minimumDuration = lookupPath.startsWith('movie/') ? 20 * 60 : 4 * 60;
          if (Number(manifest.schemaVersion) >= 2 && Number(manifest.duration) >= minimumDuration) ready.add(lookupPath);
        } catch { /* an invalid manifest remains eligible for repair */ }
      }
    };
    await visit(directory);
    return ready;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const hasCurrentCatalog = async (lookupPath) => {
  try {
    const raw = await capture('rclone', [
      'cat', `WEFLIXR2:${process.env.R2_BUCKET}/catalog/${lookupPath}.json`,
    ], 30_000, { env: rcloneEnv });
    const manifest = JSON.parse(raw);
    const minimumDuration = lookupPath.startsWith('movie/') ? 20 * 60 : 4 * 60;
    return Number(manifest.schemaVersion) >= 2 && Number(manifest.duration) >= minimumDuration;
  } catch {
    return false;
  }
};

const hasR2Variant = async (lookupPath, quality) => {
  try {
    const playlist = await capture('rclone', ['cat', `WEFLIXR2:${process.env.R2_BUCKET}/hls/${lookupPath}/${quality}/video/index.m3u8`], 20_000, { env: rcloneEnv });
    return playlist.startsWith('#EXTM3U') && playlist.includes('#EXTINF:');
  } catch { return false; }
};

const r2HlsLayout = ['legacy-ts', 'byterange-fmp4'].includes(process.env.R2_HLS_LAYOUT)
  ? process.env.R2_HLS_LAYOUT
  : 'byterange-fmp4';
const r2Fmp4CanaryLimit = Math.max(0, Math.min(20, Number(process.env.R2_FMP4_CANARY_LIMIT) || 0));
const r2Fmp4CanaryStatePath = process.env.R2_FMP4_CANARY_STATE_PATH || '/state/r2-fmp4-canaries.json';
const r2Fmp4Canaries = new Set();
let r2Fmp4CanaryStateWrite = Promise.resolve();

const loadR2Fmp4Canaries = async () => {
  try {
    const saved = JSON.parse(await readFile(r2Fmp4CanaryStatePath, 'utf8'));
    for (const lookupPath of Array.isArray(saved) ? saved : []) {
      if (/^(movie\/\d+|episode\/\d+\/\d+\/\d+)$/.test(lookupPath)) r2Fmp4Canaries.add(lookupPath);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`État canari fMP4 illisible: ${error.message}`);
  }
};

const selectR2Layout = async (lookupPath) => {
  if (r2HlsLayout !== 'byterange-fmp4') return 'legacy-ts';
  if (r2Fmp4CanaryLimit === 0 || r2Fmp4Canaries.has(lookupPath)) return 'byterange-fmp4';
  if (r2Fmp4Canaries.size >= r2Fmp4CanaryLimit) return 'legacy-ts';
  r2Fmp4Canaries.add(lookupPath);
  r2Fmp4CanaryStateWrite = r2Fmp4CanaryStateWrite.then(async () => {
    const temporaryPath = `${r2Fmp4CanaryStatePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify([...r2Fmp4Canaries], null, 2)}\n`);
    await rename(temporaryPath, r2Fmp4CanaryStatePath);
  }).catch((error) => console.error(`Sauvegarde canaris fMP4: ${error.message}`));
  await r2Fmp4CanaryStateWrite;
  return 'byterange-fmp4';
};

const playlistDuration = (playlist) => [...playlist.matchAll(/^#EXTINF:([\d.]+)/gm)]
  .reduce((total, match) => total + Number(match[1]), 0);

const validateLocalFmp4Variant = async (directory, minimumDuration) => {
  const playlist = await readFile(join(directory, 'index.m3u8'), 'utf8');
  const mediaPath = join(directory, 'media.m4s');
  const mediaInfo = await stat(mediaPath);
  const duration = playlistDuration(playlist);
  if (!playlist.includes('#EXT-X-MAP:') || !playlist.includes('#EXT-X-BYTERANGE:')) throw new Error('Playlist fMP4 sans carte d’initialisation ou Byte-Range.');
  if (mediaInfo.size < 1024) throw new Error('Fichier fMP4 local incomplet.');
  if (duration < minimumDuration) throw new Error(`Durée fMP4 locale insuffisante (${Math.round(duration)} s).`);
  return { duration, bytes: mediaInfo.size };
};

const validateRemoteFmp4Variant = async (remoteDirectory, minimumDuration) => {
  const playlist = await capture('rclone', ['cat', `${remoteDirectory}/index.m3u8`], 30_000, { env: rcloneEnv });
  const sizeRaw = await capture('rclone', ['size', '--json', `${remoteDirectory}/media.m4s`], 30_000, { env: rcloneEnv });
  const bytes = Number(JSON.parse(sizeRaw).bytes) || 0;
  const duration = playlistDuration(playlist);
  if (!playlist.includes('#EXT-X-MAP:') || !playlist.includes('#EXT-X-BYTERANGE:')) throw new Error('Playlist fMP4 R2 invalide.');
  if (bytes < 2048 || duration < minimumDuration) throw new Error('Fichier fMP4 R2 incomplet.');
  const sampleSize = Math.min(4096, bytes);
  const offsets = [0, Math.max(0, Math.floor(bytes / 2) - Math.floor(sampleSize / 2))];
  for (const [index, offset] of offsets.entries()) {
    const sample = await captureBuffer('rclone', ['cat', '--offset', String(offset), '--count', String(sampleSize), `${remoteDirectory}/media.m4s`], 30_000, { env: rcloneEnv });
    if (sample.length !== sampleSize) throw new Error(`Échantillon R2 incomplet à l’octet ${offset}.`);
    if (index === 0 && (!sample.includes(Buffer.from('ftyp')) || !sample.includes(Buffer.from('moov')))) {
      throw new Error('Initialisation fMP4 R2 invalide.');
    }
  }
  return { duration, bytes };
};

const encodeAndUpload = async ({ sourcePath, objectPrefix, manifests, quality = '720p', profileHint = null, backgroundLane = null }) => {
  if (!sourcePath?.startsWith('/data/') && !sourcePath?.startsWith('http://r2-importer:8788/media/source?lookup=') && !sourcePath?.startsWith('http://r2-importer:8788/media/alldebrid?lookup=')) {
    throw new Error(`Chemin média refusé : ${sourcePath || 'vide'}.`);
  }
  let mediaInput = sourcePath;
  try {
    const target = await readlink(sourcePath);
    if (target.startsWith('/data/alldebrid/')) {
      const remotePath = target.slice('/data/alldebrid/'.length).split('/').map(encodeURIComponent).join('/');
      mediaInput = `http://rclone-http:8686/${remotePath}`;
    }
  } catch { /* fichier local standard */ }
  if (!mediaInput.startsWith('http')) await access(mediaInput);
  const [tracks, profile] = await Promise.all([audioStreams(mediaInput), profileHint ? Promise.resolve(profileHint) : mediaProfile(mediaInput)]);
  const is1080p = quality === '1080p';
  const maxHeight = is1080p ? 1080 : 720;
  // Availability comes first: an already browser-compatible H.264 source up
  // to 1080p can be repackaged as HLS without spending several minutes
  // scaling it to 720p. The master playlist advertises its real dimensions.
  const canRemuxVideo = profile.videoCodec === 'h264' && profile.height > 0 && profile.height <= 1080;
  const copiedAudioTracks = tracks.filter((track) => track.codec === 'aac' && track.channels > 0 && track.channels <= 2);
  const selectedLayout = await selectR2Layout(manifests[0]?.lookupPath || '');
  const useFmp4 = selectedLayout === 'byterange-fmp4';
  const effectiveLane = backgroundLane || (canRemuxVideo ? 'light' : 'heavy');
  const deliveryMode = `${canRemuxVideo ? 'remux' : 'transcode'}_${useFmp4 ? 'fmp4' : 'hls'}`;
  console.log(`Pipeline ${objectPrefix}/${quality}: ${deliveryMode}, vidéo=${profile.videoCodec || 'inconnue'} ${profile.width}x${profile.height}, audio copié=${copiedAudioTracks.length}/${tracks.length}.`);
  const maxRate = is1080p ? '3500k' : '2200k';
  const bufferSize = is1080p ? '7000k' : '4400k';
  const output = await mkdtemp(join(tmpdir(), 'weflix-arr-hls-'));
  try {
    const videoDirectory = join(output, 'video');
    await mkdir(videoDirectory, { recursive: true });
    for (const track of tracks) await mkdir(join(output, `audio-${track.index}`), { recursive: true });
    const hlsOutputArgs = (directory) => useFmp4
      ? ['-hls_time', '6', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_flags', 'independent_segments+single_file', '-hls_segment_filename', join(directory, 'media.m4s'), join(directory, 'index.m3u8')]
      : ['-hls_time', '6', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments', '-hls_segment_filename', join(directory, 'segment-%05d.ts'), join(directory, 'index.m3u8')];
    const ffmpegArgs = [
      '-hide_banner', '-loglevel', 'warning', '-nostats', '-y', '-i', mediaInput,
      '-map', '0:v:0', '-an',
      ...(canRemuxVideo
        ? ['-c:v', 'copy']
        : ['-vf', `scale=-2:'min(${maxHeight},ih)'`, '-c:v', 'libx264', '-preset', is1080p ? 'superfast' : 'ultrafast', '-crf', is1080p ? '23' : '24', '-maxrate', maxRate, '-bufsize', bufferSize, '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1', '-threads', '2', '-force_key_frames', 'expr:gte(t,n_forced*6)']),
      ...hlsOutputArgs(videoDirectory),
    ];
    for (const track of tracks) {
      const audioDirectory = join(output, `audio-${track.index}`);
      const canCopyAudio = track.codec === 'aac' && track.channels > 0 && track.channels <= 2;
      ffmpegArgs.push(
        '-map', `0:${track.sourceIndex}`, '-vn',
        ...(canCopyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k', '-ac', '2']),
        ...hlsOutputArgs(audioDirectory),
      );
    }
    await run('ffmpeg', ffmpegArgs, {
      timeoutMs: 6 * 60 * 60 * 1000,
      onSpawn: (child) => registerBackgroundProcess(child, { kind: 'encode', lane: effectiveLane }),
    });
    const playlist = await readFile(join(videoDirectory, 'index.m3u8'), 'utf8');
    const duration = playlistDuration(playlist);
    const minimumDuration = manifests[0]?.lookupPath?.startsWith('movie/') ? 20 * 60 : 4 * 60;
    let outputBytes = 0;
    if (useFmp4) {
      const videoValidation = await validateLocalFmp4Variant(videoDirectory, minimumDuration);
      outputBytes += videoValidation.bytes;
      for (const track of tracks) {
        const audioValidation = await validateLocalFmp4Variant(join(output, `audio-${track.index}`), minimumDuration);
        outputBytes += audioValidation.bytes;
      }
    }
    const escapeAttribute = (value) => String(value).replace(/["\r\n]/g, '');
    // Upload media and child playlists first. The public master and catalogue
    // are written only after remote range validation succeeds.
    const remoteQuality = `WEFLIXR2:${process.env.R2_BUCKET}/${objectPrefix}/${quality}`;
    await run('rclone', [
      useFmp4 ? 'copy' : 'sync', output, remoteQuality,
      '--exclude', 'master.m3u8', '--exclude', 'catalog-*.json',
      '--transfers', '4', '--s3-upload-concurrency', '8', '--s3-chunk-size', '16Mi',
      '--stats', '30s', '--stats-one-line',
    ], {
      env: rcloneEnv, timeoutMs: 2 * 60 * 60 * 1000,
      onSpawn: (child) => registerBackgroundProcess(child, { kind: 'upload', lane: effectiveLane }),
    });
    if (useFmp4) {
      const remoteVideo = await validateRemoteFmp4Variant(`${remoteQuality}/video`, minimumDuration);
      outputBytes = remoteVideo.bytes;
      for (const track of tracks) {
        const remoteAudio = await validateRemoteFmp4Variant(`${remoteQuality}/audio-${track.index}`, minimumDuration);
        outputBytes += remoteAudio.bytes;
      }
    }
    const lookupPath = manifests[0]?.lookupPath;
    const variants = {
      '720p': quality === '720p' || await hasR2Variant(lookupPath, '720p'),
      '1080p': quality === '1080p' || await hasR2Variant(lookupPath, '1080p'),
    };
    const audioQuality = variants['720p'] ? '720p' : quality;
    const renderedHeight = canRemuxVideo ? profile.height : Math.min(maxHeight, profile.height);
    const renderedWidth = canRemuxVideo || profile.width <= 0 || profile.height <= 0
      ? profile.width
      : Math.max(2, Math.round((profile.width * renderedHeight / profile.height) / 2) * 2);
    const currentResolution = renderedWidth > 0 && renderedHeight > 0
      ? `${renderedWidth}x${renderedHeight}`
      : (is1080p ? '1920x1080' : '1280x720');
    const resolution720p = quality === '720p' ? currentResolution : '1280x720';
    const resolution1080p = quality === '1080p' ? currentResolution : '1920x1080';
    const master = [
      '#EXTM3U', `#EXT-X-VERSION:${useFmp4 ? 7 : 6}`,
      ...tracks.map((track) => `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${escapeAttribute(track.title)}",LANGUAGE="${escapeAttribute(track.language)}",DEFAULT=${track.default ? 'YES' : 'NO'},AUTOSELECT=YES,URI="${audioQuality}/audio-${track.index}/index.m3u8"`),
      ...(variants['720p'] ? [`#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=3500000,RESOLUTION=${resolution720p},AUDIO="audio"`, '720p/video/index.m3u8'] : []),
      ...(variants['1080p'] ? [`#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=3500000,RESOLUTION=${resolution1080p},AUDIO="audio"`, '1080p/video/index.m3u8'] : []),
      '',
    ].join('\n');
    const masterPath = join(output, 'master.m3u8');
    await writeFile(masterPath, master);
    await run('rclone', ['copyto', masterPath, `WEFLIXR2:${process.env.R2_BUCKET}/${objectPrefix}/index.m3u8`], { env: rcloneEnv });
    for (const [index, manifest] of manifests.entries()) {
      const publicTracks = tracks.map(({ sourceIndex, codec, channels, ...track }) => track);
      const body = `${JSON.stringify({ schemaVersion: useFmp4 ? 3 : 2, key: `${objectPrefix}/index.m3u8`, title: manifest.title, duration, format: 'hls', layout: useFmp4 ? 'byterange-fmp4' : 'legacy-ts', qualities: Object.keys(variants).filter((name) => variants[name]), audioTracks: publicTracks, subtitleTracks: [], updatedAt: new Date().toISOString() }, null, 2)}\n`;
      const manifestPath = join(output, `catalog-${index}.json`);
      await writeFile(manifestPath, body);
      await run('rclone', ['copyto', manifestPath, `WEFLIXR2:${process.env.R2_BUCKET}/catalog/${manifest.lookupPath}.json`], { env: rcloneEnv });
    }
    return {
      deliveryMode,
      videoCodec: profile.videoCodec || 'unknown',
      audioCopied: copiedAudioTracks.length,
      audioTracks: tracks.length,
      duration,
      bytes: outputBytes,
      objectCount: useFmp4 ? 3 + (tracks.length * 2) + manifests.length : null,
      layout: useFmp4 ? 'byterange-fmp4' : 'legacy-ts',
    };
  } finally {
    await rm(output, { recursive: true, force: true });
  }
};

const processRadarr = async (payload) => {
  if (!['Download', 'MovieFileRenamed'].includes(payload.eventType)) return;
  const tmdbId = payload.movie?.tmdbId;
  const sourcePath = payload.movieFile?.path;
  if (!tmdbId || !sourcePath) throw new Error('Webhook Radarr incomplet.');
  await createStreamPointer(sourcePath);
  await encodeAndUpload({
    sourcePath,
    objectPrefix: `hls/movie/${tmdbId}`,
    manifests: [{ lookupPath: `movie/${tmdbId}`, title: payload.movie?.title || `Film ${tmdbId}` }],
  });
};

const processSonarr = async (payload) => {
  if (!['Download', 'EpisodeFileRenamed'].includes(payload.eventType)) return;
  const sourcePath = payload.episodeFile?.path;
  const tvdbId = payload.series?.tvdbId;
  const episodes = payload.episodes || [];
  if (!sourcePath || !tvdbId || !episodes.length) throw new Error('Webhook Sonarr incomplet.');
  await createStreamPointer(sourcePath);
  const tmdbId = await tmdbFromTvdb(tvdbId);
  const first = episodes[0];
  await encodeAndUpload({
    sourcePath,
    objectPrefix: `hls/episode/${tmdbId}/${first.seasonNumber}/${first.episodeNumber}`,
    manifests: episodes.map((episode) => ({
      lookupPath: `episode/${tmdbId}/${episode.seasonNumber}/${episode.episodeNumber}`,
      title: `${payload.series?.title || `Série ${tmdbId}`} — S${String(episode.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')}`,
    })),
  });
};

const syncExisting = async () => {
  for (const name of ['RADARR_URL', 'RADARR_API_KEY', 'SONARR_URL', 'SONARR_API_KEY']) {
    if (!process.env[name]) throw new Error(`${name} manque pour la synchronisation.`);
  }
  const catalog = await existingCatalog();
  const movies = await arrJson(process.env.RADARR_URL, process.env.RADARR_API_KEY, '/api/v3/movie');
  for (const movie of movies.filter((item) => item.hasFile && item.movieFile?.path)) {
    const lookupPath = `movie/${movie.tmdbId}`;
    if (await hasCurrentCatalog(lookupPath)) continue;
    try {
      await encodeAndUpload({ sourcePath: movie.movieFile.path, objectPrefix: `hls/${lookupPath}`, manifests: [{ lookupPath, title: movie.title }] });
      catalog.add(lookupPath);
    } catch (error) {
      console.error(`Film ignoré (${movie.title}) : ${error.message}`);
    }
  }

  const seriesList = await arrJson(process.env.SONARR_URL, process.env.SONARR_API_KEY, '/api/v3/series');
  for (const series of seriesList.filter((item) => item.statistics?.episodeFileCount > 0)) {
    const tmdbId = await tmdbFromTvdb(series.tvdbId);
    const [files, episodes] = await Promise.all([
      arrJson(process.env.SONARR_URL, process.env.SONARR_API_KEY, `/api/v3/episodefile?seriesId=${series.id}`),
      arrJson(process.env.SONARR_URL, process.env.SONARR_API_KEY, `/api/v3/episode?seriesId=${series.id}`),
    ]);
    const episodeByFile = new Map(episodes.filter((episode) => episode.hasFile).map((episode) => [episode.episodeFileId, episode]));
    for (const file of files) {
      const episode = episodeByFile.get(file.id);
      if (!episode) continue;
      const lookupPath = `episode/${tmdbId}/${episode.seasonNumber}/${episode.episodeNumber}`;
      if (await hasCurrentCatalog(lookupPath)) continue;
      try {
        await encodeAndUpload({
          sourcePath: file.path,
          objectPrefix: `hls/${lookupPath}`,
          manifests: [{ lookupPath, title: `${series.title} — S${String(episode.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')}` }],
        });
        catalog.add(lookupPath);
      } catch (error) {
        console.error(`Épisode ignoré (${series.title} S${episode.seasonNumber}E${episode.episodeNumber}) : ${error.message}`);
      }
    }
  }
};

let catalogueAuditCursor = 0;
let catalogueAuditRunning = false;
const auditReadyCatalogueBatch = async () => {
  if (catalogueAuditRunning) return;
  catalogueAuditRunning = true;
  try {
    const ready = [...provisions.values()].filter((item) => item.status === 'ready' && item.magnetId);
    if (!ready.length) return;
    const configuredBatchSize = Number(process.env.R2_AUDIT_BATCH_SIZE);
    if (Number.isFinite(configuredBatchSize) && configuredBatchSize <= 0) return;
    const batchSize = Math.max(1, Math.min(20, configuredBatchSize || 8));
    const batch = Array.from({ length: Math.min(batchSize, ready.length) }, (_, index) => ready[(catalogueAuditCursor + index) % ready.length]);
    catalogueAuditCursor = (catalogueAuditCursor + batch.length) % ready.length;
    for (const provision of batch) {
      const alreadyReady = !provision.r2RefreshRequired && await hasCurrentCatalog(provision.lookupPath);
      if (alreadyReady) {
        await cancelQueuedR2Encoding(provision.lookupPath, '720p');
      } else if (!r2OnDemandOnly) {
        if (!provision.preload && r2EncodingQueued.size >= cataloguePreloadMaxR2Pending) continue;
        scheduleR2Encoding(
          provision.lookupPath,
          provision.title,
          Boolean(provision.r2RefreshRequired),
          provision.preload ? 0 : 3,
        );
      }
    }
  } catch (error) {
    console.error(`Audit catalogue R2: ${error.message}`);
  } finally {
    catalogueAuditRunning = false;
  }
};

const priorityQueues = [[], [], [], []];
const queuedTaskKeys = new Set();
let taskQueueRunning = false;
let activeTaskLabel = null;

const taskQueueDepths = () => Object.fromEntries(priorityQueues.map((items, priority) => [`p${priority}`, items.length]));

const drainTaskQueue = async () => {
  if (taskQueueRunning) return;
  taskQueueRunning = true;
  try {
    while (priorityQueues.some((items) => items.length)) {
      const priority = priorityQueues.findIndex((items) => items.length);
      const job = priorityQueues[priority].shift();
      activeTaskLabel = job.label;
      console.log(`[${new Date().toISOString()}] Début P${priority} ${job.label}`);
      try {
        await job.task();
        console.log(`[${new Date().toISOString()}] Fin P${priority} ${job.label}`);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Échec P${priority} ${job.label}:`, error.message);
      } finally {
        queuedTaskKeys.delete(job.dedupeKey);
        activeTaskLabel = null;
      }
    }
  } finally {
    taskQueueRunning = false;
  }
};

const enqueue = (label, task, { priority = 2, dedupeKey = label } = {}) => {
  const normalizedPriority = Math.max(0, Math.min(3, Number(priority) || 0));
  if (queuedTaskKeys.has(dedupeKey)) return false;
  queuedTaskKeys.add(dedupeKey);
  priorityQueues[normalizedPriority].push({ label, task, dedupeKey });
  queueMicrotask(drainTaskQueue);
  return true;
};

const percentile = (values, ratio) => {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
};

const originMetrics = () => {
  const items = [...provisions.values()];
  const sourceSeconds = items.filter((item) => item.attemptStartedAt && item.readyAt).map((item) => (Date.parse(item.readyAt) - Date.parse(item.attemptStartedAt)) / 1000).filter((value) => value >= 0);
  const firstFrameSeconds = items.filter((item) => item.liveStartedAt && item.liveReadyAt).map((item) => (Date.parse(item.liveReadyAt) - Date.parse(item.liveStartedAt)) / 1000).filter((value) => value >= 0);
  const r2Seconds = items.flatMap((item) => [Number(item.r2720pEncodingSeconds), Number(item.r21080pEncodingSeconds)]).filter((value) => Number.isFinite(value) && value >= 0);
  const modeSeconds = (mode) => items.filter((item) => item.r2720pDeliveryMode === mode).map((item) => Number(item.r2720pEncodingSeconds)).filter((value) => Number.isFinite(value) && value >= 0);
  const r2Priorities = Object.fromEntries(r2LaneQueues.map((queue, priority) => [`r2p${priority}`, queue.length]));
  return {
    generatedAt: new Date().toISOString(), queues: { ...taskQueueDepths(), ...r2Priorities },
    activeTask: activeTaskLabel || [...r2ActiveJobs.values()].map((job) => `${job.lane} ${job.quality} ${job.lookupPath}`).join(', ') || null,
    provisioning: { queued: provisionQueue.length, active: runningProvisions, backgroundActive: runningBackgroundProvisions },
    preload: {
      enabled: cataloguePreloadEnabled, running: cataloguePreloadRunning,
      page: cataloguePreloadState.page, offset: cataloguePreloadState.offset,
      queued: cataloguePreloadState.queued, skipped: cataloguePreloadState.skipped,
      errors: cataloguePreloadState.errors, lastQueuedAt: cataloguePreloadState.lastQueuedAt,
      lastLookupPath: cataloguePreloadState.lastLookupPath, pausedByR2Backlog: r2EncodingQueued.size >= cataloguePreloadMaxR2Pending,
    },
    live: {
      queued: liveTranscodeQueue.length, active: liveTranscodesRunning,
      interactive: interactiveLiveTranscodes(), sessions: liveSessions.size,
      r2EncodingPaused: backgroundProcessingPaused(),
    },
    direct: {
      enabled: directPlayEnabled,
      compatibleMedia: items.filter((item) => item.directProfile && item.directSourceId).length,
      activeSessions: [...liveSessions.values()].filter((session) => session.deliveryMode === 'direct_range').length,
      warming: edgeCacheWarms.size,
      cacheHeadMb: Math.round(edgeCacheHeadBytes / 1024 ** 2),
      cacheTailMb: Math.round(edgeCacheTailBytes / 1024 ** 2),
      cacheMaximumEntries: edgeCacheMaxEntries,
    },
    multiSource: {
      enabled: multiSourceEnabled, maximum: multiSourceMaximum,
      media: items.filter((item) => provisionSourceCandidates(item).length > 1).length,
      candidates: items.reduce((total, item) => total + provisionSourceCandidates(item).length, 0),
      failed: items.reduce((total, item) => total + provisionSourceCandidates(item).filter((source) => source.state === 'failed').length, 0),
      discovering: multiSourceDiscoveries.size,
    },
    discovery: {
      primary: cometPrimaryEnabled ? 'comet' : 'arr',
      comet: items.filter((item) => item.discoveryProvider === 'comet').length,
      arr: items.filter((item) => item.discoveryProvider === 'arr').length,
    },
    states: items.reduce((counts, item) => ({ ...counts, [item.availabilityState || item.status || 'unknown']: (counts[item.availabilityState || item.status || 'unknown'] || 0) + 1 }), {}),
    blocked: items.filter((item) => item.status === 'retrying' && Date.now() - Date.parse(item.updatedAt || 0) > 60 * 60_000).length,
    timings: {
      source: { median: percentile(sourceSeconds, 0.5), p95: percentile(sourceSeconds, 0.95) },
      firstFrame: { median: percentile(firstFrameSeconds, 0.5), p95: percentile(firstFrameSeconds, 0.95) },
      r2: { median: percentile(r2Seconds, 0.5), p95: percentile(r2Seconds, 0.95) },
      remuxFmp4: { median: percentile(modeSeconds('remux_fmp4'), 0.5), p95: percentile(modeSeconds('remux_fmp4'), 0.95) },
      transcodeFmp4: { median: percentile(modeSeconds('transcode_fmp4'), 0.5), p95: percentile(modeSeconds('transcode_fmp4'), 0.95) },
    },
    r2: {
      layout: r2HlsLayout, canaryLimit: r2Fmp4CanaryLimit, canaries: [...r2Fmp4Canaries], pending: r2EncodingQueued.size, lanes: r2LaneDepths(),
      active: [...r2ActiveJobs.values()].map((job) => ({ lookupPath: job.lookupPath, quality: job.quality, lane: job.lane, priority: job.priority })),
      paused: Boolean(r2PauseReason || backgroundProcessingPaused()),
      pauseReason: r2PauseReason || (backgroundProcessingPaused() ? 'interactive-playback' : null),
      backgroundProcesses: {
        active: activeBackgroundProcesses.size,
        paused: [...activeBackgroundProcesses.values()].filter((process) => process.paused).length,
      },
      mode: r2OnDemandOnly ? 'on_demand' : 'catalogue_preload', cataloguePreloadEnabled,
      minimumFreeDiskGb: Math.round(r2MinimumFreeBytes / 1024 ** 3), repairsPruned: r2RepairsPruned,
      bytesPublished: items.reduce((total, item) => total + Number(item.r2720pBytes || 0), 0),
      objectsPublished: items.reduce((total, item) => total + Number(item.r2720pObjectCount || 0), 0),
    },
    delivery: items.reduce((counts, item) => {
      const mode = item.r2720pDeliveryMode;
      if (mode) counts[mode] = (counts[mode] || 0) + 1;
      return counts;
    }, {}),
  };
};

createServer(async (request, response) => {
  const requestUrl = new URL(request.url || '/', 'http://local');
  if (request.method === 'OPTIONS' && (requestUrl.pathname.startsWith('/live/') || requestUrl.pathname.startsWith('/direct/'))) {
    response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Range' });
    return response.end();
  }
  if (['GET', 'HEAD'].includes(request.method) && requestUrl.pathname.startsWith('/direct/')) {
    try { return await serveDirectMedia(request, response, requestUrl); }
    catch (error) {
      console.error(`Lecture directe: ${error.message}`);
      if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return response.end(response.headersSent ? undefined : JSON.stringify({ error: 'La vidéo est momentanément indisponible.' }));
    }
  }
  if (['GET', 'HEAD'].includes(request.method) && requestUrl.pathname.startsWith('/live/')) {
    return serveLiveMedia(request, response, requestUrl);
  }
  if (request.method === 'POST' && requestUrl.pathname === '/playback/session') {
    if (!liveServiceAuthenticated(request)) { response.writeHead(401); return response.end(); }
    try {
      const payload = await readBody(request);
      const lookupPath = String(payload.lookupPath || '');
      if (!/^(movie\/\d+|episode\/\d+\/\d+\/\d+)$/.test(lookupPath)) throw new Error('Média invalide.');
      const start = Math.max(0, Number(payload.start) || 0);
      let sourceId = /^[A-Za-z0-9_-]{8,32}$/.test(String(payload.sourceId || '')) ? String(payload.sourceId) : '';
      if (payload.directOnly === true) {
        const provision = provisions.get(lookupPath);
        const directCandidate = provisionSourceCandidates(provision)
          .find((candidate) => candidate.id === provision?.directSourceId && candidate.state !== 'failed');
        if (!directPlayEnabled || !provision?.directProfile || !directCandidate) {
          response.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          return response.end(JSON.stringify({ available: false, state: 'direct_unavailable', lookupPath }));
        }
        sourceId = directCandidate.id;
      }
      const session = getOrCreateLiveSession(lookupPath, start, sourceId);
      if (!session) {
        response.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return response.end(JSON.stringify({ available: false, state: 'source_unavailable', lookupPath }));
      }
      const body = liveSessionPayload(session);
      response.writeHead(body.available ? 200 : body.state === 'failed' ? 503 : 202, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return response.end(JSON.stringify(body));
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ error: error.message }));
    }
  }
  if (request.method === 'POST' && /^\/playback\/session\/[a-f0-9-]+\/(heartbeat|close)$/.test(requestUrl.pathname)) {
    if (!liveServiceAuthenticated(request)) { response.writeHead(401); return response.end(); }
    const [, , , sessionId, action] = requestUrl.pathname.split('/');
    const session = liveSessions.get(sessionId);
    if (!session) { response.writeHead(404); return response.end(); }
    session.lastHeartbeatAt = new Date().toISOString();
    if (action === 'heartbeat') session.viewers = Math.max(1, Number(session.viewers) || 1);
    if (action === 'close') {
      session.viewers = Math.max(0, (Number(session.viewers) || 1) - 1);
      if (!session.viewers && !['complete', 'failed'].includes(session.status)) {
        if (session.startOffset === 0 && ['queued', 'preparing', 'live_ready'].includes(session.status)) {
          if (r2HlsLayout === 'byterange-fmp4') {
            // The durable P0 fMP4 job is already queued. Continuing the
            // temporary TS encoder after the viewer leaves would encode the
            // same title twice and slow every subsequent preload.
            session.preempted = true;
            if (session.process?.exitCode === null && session.process?.signalCode === null) session.process.kill('SIGTERM');
            const queueIndex = liveTranscodeQueue.indexOf(session);
            if (queueIndex >= 0) liveTranscodeQueue.splice(queueIndex, 1);
            liveSessions.delete(session.id);
            if (liveSessionByLookup.get(session.sessionKey) === session.id) liveSessionByLookup.delete(session.sessionKey);
            rm(session.directory, { recursive: true, force: true }).catch(() => null);
          } else {
            session.backgroundOnly = true;
          }
        } else if (session.status === 'queued') {
          session.status = 'failed';
          session.failedAt = new Date().toISOString();
          session.preempted = true;
          const queueIndex = liveTranscodeQueue.indexOf(session);
          if (queueIndex >= 0) liveTranscodeQueue.splice(queueIndex, 1);
          liveSessions.delete(session.id);
          if (liveSessionByLookup.get(session.sessionKey) === session.id) liveSessionByLookup.delete(session.sessionKey);
          rm(session.directory, { recursive: true, force: true }).catch(() => null);
        } else if (session.process?.exitCode === null && session.process?.signalCode === null) {
          session.process.kill('SIGTERM');
        }
        updateBackgroundTranscodeScheduling();
        drainLiveTranscodes();
      }
    }
    response.writeHead(204, { 'Cache-Control': 'no-store' });
    return response.end();
  }
  if (request.method === 'GET' && requestUrl.pathname === '/metrics') {
    if (!liveServiceAuthenticated(request)) { response.writeHead(401); return response.end(); }
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return response.end(JSON.stringify(originMetrics()));
  }
  if (request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    return response.end(JSON.stringify({
      ok: true, r2EncodingPending: r2EncodingQueued.size, queues: { ...taskQueueDepths(), ...Object.fromEntries(r2LaneQueues.map((queue, priority) => [`r2p${priority}`, queue.length])) },
      activeTask: activeTaskLabel || [...r2ActiveJobs.values()].map((job) => `${job.lane} ${job.quality} ${job.lookupPath}`).join(', ') || null,
      r2: { layout: r2HlsLayout, lanes: r2LaneDepths(), pauseReason: r2PauseReason },
      provisioning: { queued: provisionQueue.length, active: runningProvisions, backgroundActive: runningBackgroundProvisions },
      preload: { enabled: cataloguePreloadEnabled, page: cataloguePreloadState.page, offset: cataloguePreloadState.offset, queued: cataloguePreloadState.queued, lastLookupPath: cataloguePreloadState.lastLookupPath },
    }));
  }
  if (['GET', 'HEAD'].includes(request.method) && (request.url?.startsWith('/media/source') || request.url?.startsWith('/media/alldebrid'))) {
    const host = String(request.headers.host || '').split(':')[0].toLowerCase();
    if (!['r2-importer', '127.0.0.1', 'localhost'].includes(host)) {
      response.writeHead(404); return response.end();
    }
    try { return await proxyDebridMedia(request, response); }
    catch (error) {
      console.error(`Proxy AllDebrid: ${error.message}`);
      if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json' });
      return response.end(response.headersSent ? undefined : JSON.stringify({ error: error.message }));
    }
  }
  if (request.method === 'GET' && request.url?.startsWith('/status/')) {
    if (!authenticated(request)) { response.writeHead(401); return response.end(); }
    const lookupPath = decodeURIComponent(request.url.slice('/status/'.length).split('?')[0]).replace(/^\/+|\/+$/g, '');
    const value = publicProvision(provisions.get(lookupPath));
    response.writeHead(value ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return response.end(JSON.stringify(value || { status: 'unknown', lookupPath }));
  }
  if (request.method === 'POST' && request.url === '/provision') {
    if (!authenticated(request)) { response.writeHead(401); return response.end(); }
    try {
      const payload = await readBody(request);
      const mediaId = Number(payload.mediaId);
      if (!Number.isInteger(mediaId) || mediaId <= 0 || !['movie', 'tv'].includes(payload.mediaType)) throw new Error('Média invalide.');
      const value = startProvision(payload);
      response.writeHead(202, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return response.end(JSON.stringify({ accepted: true, provision: value }));
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ error: error.message }));
    }
  }
  if (request.method === 'POST' && request.url === '/sync') {
    if (!authenticated(request)) { response.writeHead(401); return response.end(); }
    enqueue('synchronisation complète', syncExisting, { priority: 3, dedupeKey: 'catalogue:full-sync' });
    response.writeHead(202, { 'Content-Type': 'application/json' });
    return response.end(JSON.stringify({ accepted: true }));
  }
  if (request.method === 'POST' && request.url === '/requests/sync') {
    if (!authenticated(request)) { response.writeHead(401); return response.end(); }
    try {
      const processed = await forwardQueuedRequests();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ processed }));
    } catch (error) {
      response.writeHead(502, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ error: error.message }));
    }
  }
  const match = /^\/webhook\/(radarr|sonarr)$/.exec(request.url || '');
  if (request.method !== 'POST' || !match) { response.writeHead(404); return response.end(); }
  if (!authenticated(request)) { response.writeHead(401); return response.end(); }
  try {
    const payload = await readBody(request);
    enqueue(`${match[1]}:${payload.eventType || 'unknown'}`, () => match[1] === 'radarr' ? processRadarr(payload) : processSonarr(payload), { priority: 1, dedupeKey: `${match[1]}:${payload.downloadId || payload.movieFile?.id || payload.episodeFile?.id || randomUUID()}` });
    response.writeHead(202, { 'Content-Type': 'application/json' });
    return response.end(JSON.stringify({ accepted: true }));
  } catch (error) {
    response.writeHead(400, { 'Content-Type': 'application/json' });
    return response.end(JSON.stringify({ error: error.message }));
  }
}).listen(8788, '0.0.0.0', async () => {
  console.log('R2 importer écoute sur :8788');
  console.log('Les imports automatiques sont déclenchés par les webhooks Radarr/Sonarr.');
  await loadProvisionState();
  await loadCataloguePreloadState();
  await loadR2Fmp4Canaries();
  for (const entry of await readdir(tmpdir()).catch(() => [])) {
    if (/^weflix-(arr-hls|live-publish)-/.test(entry)) await rm(join(tmpdir(), entry), { recursive: true, force: true }).catch(() => null);
  }
  let indexedR2Catalog = new Set();
  try {
    indexedR2Catalog = await currentCatalogIndex();
    let changed = false;
    const indexedAt = new Date().toISOString();
    for (const lookupPath of indexedR2Catalog) {
      const provision = provisions.get(lookupPath);
      if (!provision || (provision.availabilityState === 'r2_ready' && !provision.r2RefreshRequired)) continue;
      provisions.set(lookupPath, {
        ...provision, lookupPath, availabilityState: 'r2_ready', r2RefreshRequired: false,
        r2ReadyAt: provision.r2ReadyAt || indexedAt, r2IndexedAt: indexedAt,
      });
      changed = true;
    }
    if (changed) await persistProvisionSnapshot();
    console.log(`Index R2 réconcilié (${indexedR2Catalog.size} contenu(s) valide(s)).`);
  } catch (error) {
    console.error(`Réconciliation index R2: ${error.message}`);
  }
  // Live sessions only exist in this process. Old partial HLS directories can
  // never be resumed safely after a restart and are removed deterministically.
  await rm(liveHlsRoot, { recursive: true, force: true }).catch(() => null);
  await mkdir(liveHlsRoot, { recursive: true });
  try {
    const savedJobs = JSON.parse(await readFile(r2QueueStatePath, 'utf8'));
    for (const job of Array.isArray(savedJobs) ? savedJobs : []) {
      if (!/^(movie\/\d+|episode\/\d+\/\d+\/\d+)$/.test(String(job.lookupPath || ''))) continue;
      if (job.quality === '1080p' && process.env.ENABLE_BACKGROUND_1080P !== 'true') { r2RepairsPruned += 1; continue; }
      const provision = provisions.get(job.lookupPath);
      if (job.quality !== '1080p' && indexedR2Catalog.has(job.lookupPath) && (!job.force || !provision?.r2RefreshRequired)) { r2RepairsPruned += 1; continue; }
      const isPreload = Boolean(provision?.preload);
      const restoredPriority = isPreload ? 0 : (job.force ? 1 : 3);
      if (r2OnDemandOnly && restoredPriority > 0 && !isPreload) { r2RepairsPruned += 1; continue; }
      scheduleR2Encoding(job.lookupPath, job.title, Boolean(job.force), restoredPriority, job.quality === '1080p' ? '1080p' : '720p');
    }
    reprioritizeR2Queue();
    await persistR2Queue();
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`File R2 persistée illisible: ${error.message}`);
  }
  // Only explicitly invalidated media is restored immediately. The remaining
  // catalogue is audited in small batches instead of recreating hundreds of
  // transcode jobs after every restart.
  if (!r2OnDemandOnly) {
    for (const provision of [...provisions.values()].filter((item) => item.status === 'ready' && item.r2RefreshRequired).slice(0, 10)) {
      scheduleR2Encoding(provision.lookupPath, provision.title, true, 3, '720p');
    }
  }
  // Legacy Vortex/NFS recovery is opt-in only. Direct provisioning is now the
  // sole critical path, avoiding duplicate grabs and Docker Desktop NFS stalls.
  if (process.env.ENABLE_LEGACY_VORTEX === 'true') startVortexAccelerator();
  let requestForwardRunning = false;
  const runRequestForward = async () => {
    if (requestForwardRunning) return;
    requestForwardRunning = true;
    try { await forwardQueuedRequests(); } catch (error) { console.error(`File de demandes R2: ${error.message}`); }
    finally { requestForwardRunning = false; }
  };
  setTimeout(runRequestForward, 5_000);
  setInterval(runRequestForward, 10_000);
  let seerrSyncRunning = false;
  const runSeerrSync = async () => {
    if (seerrSyncRunning) return;
    seerrSyncRunning = true;
    try { await syncApprovedSeerrRequests(); } catch (error) { console.error(`Synchronisation demandes Seerr: ${error.message}`); }
    finally { seerrSyncRunning = false; }
  };
  setTimeout(runSeerrSync, 8_000);
  setInterval(runSeerrSync, 30_000);
  // Keep the current playable source online during the background check. A
  // newly available French source then replaces it and refreshes R2.
  if (!r2OnDemandOnly) {
    setTimeout(runVfUpgradeScan, 15_000);
    setInterval(runVfUpgradeScan, vfUpgradeIntervalMs);
  }
  setTimeout(auditReadyCatalogueBatch, 20_000);
  setInterval(auditReadyCatalogueBatch, 60_000);
  setInterval(drainR2Lanes, 15_000);
  if (cataloguePreloadEnabled) {
    setTimeout(runCataloguePreload, 30_000);
    setInterval(runCataloguePreload, cataloguePreloadIntervalMs);
  }
  setInterval(cleanupExpiredLiveSessions, 60_000);
  setInterval(() => {
    const now = Date.now();
    for (const provision of provisions.values()) {
      if (provision.status !== 'retrying' || Date.parse(provision.retryAt || 0) > now) continue;
      if (r2OnDemandOnly && provision.preload) continue;
      const parts = provision.lookupPath.split('/');
      startProvision(parts[0] === 'movie'
        ? { mediaType: 'movie', mediaId: Number(parts[1]), background: Boolean(provision.preload), rating: provision.preloadRating, page: provision.preloadPage }
        : { mediaType: 'tv', mediaId: Number(parts[1]), season: Number(parts[2]), episode: Number(parts[3]), background: Boolean(provision.preload), rating: provision.preloadRating, page: provision.preloadPage });
    }
  }, 30_000);
  // Le rattrapage complet reste disponible via POST /sync. Au quotidien,
  // l'audit par petits lots et les webhooks évitent de recréer une file massive.
});
