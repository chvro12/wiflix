import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const [fileArgument, lookupArgument, titleArgument] = process.argv.slice(2);
if (!fileArgument || !lookupArgument || !titleArgument) {
  console.error('Usage : npm run r2:hls -- <fichier> movie/<tmdbId> "Titre"');
  console.error('        npm run r2:hls -- <fichier> episode/<tmdbId>/<saison>/<episode> "Titre"');
  process.exit(1);
}

const filePath = resolve(fileArgument);
await access(filePath);
const lookupPath = lookupArgument.replace(/^\/+|\/+$/g, '');
if (!/^(movie\/\d+|episode\/\d+\/\d+\/\d+)$/.test(lookupPath)) throw new Error('Association TMDB invalide.');

const rawEnv = await readFile(resolve('.env.local'), 'utf8');
const localEnv = Object.fromEntries(rawEnv.split(/\r?\n/)
  .filter((line) => line && !line.trimStart().startsWith('#') && line.includes('='))
  .map((line) => { const separator = line.indexOf('='); return [line.slice(0, separator), line.slice(separator + 1).replace(/^['"]|['"]$/g, '')]; }));
for (const name of ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT', 'R2_BUCKET']) {
  if (!localEnv[name]) throw new Error(`${name} manque dans .env.local.`);
}

const run = (command, args, options = {}) => new Promise((done, reject) => {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  child.once('error', reject);
  child.once('close', (code) => code === 0 ? done() : reject(new Error(`${command} a quitté avec le code ${code}.`)));
});

const outputDirectory = await mkdtemp(join(tmpdir(), 'weflix-hls-'));
const playlistPath = join(outputDirectory, 'index.m3u8');
const segmentPattern = join(outputDirectory, 'segment-%05d.ts');
console.log('Encodage HLS 720p H.264/AAC…');
await run('/opt/homebrew/bin/ffmpeg', [
  '-hide_banner', '-y', '-i', filePath,
  '-map', '0:v:0', '-map', '0:a:0?',
  '-vf', "scale=-2:'min(720,ih)'",
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-profile:v', 'high', '-level', '4.1',
  '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
  '-force_key_frames', 'expr:gte(t,n_forced*6)',
  '-hls_time', '6', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
  '-hls_segment_filename', segmentPattern, playlistPath,
]);

const rcloneEnv = {
  ...process.env,
  RCLONE_CONFIG_WEFLIXR2_TYPE: 's3',
  RCLONE_CONFIG_WEFLIXR2_PROVIDER: 'Cloudflare',
  RCLONE_CONFIG_WEFLIXR2_ACCESS_KEY_ID: localEnv.R2_ACCESS_KEY_ID,
  RCLONE_CONFIG_WEFLIXR2_SECRET_ACCESS_KEY: localEnv.R2_SECRET_ACCESS_KEY,
  RCLONE_CONFIG_WEFLIXR2_ENDPOINT: localEnv.R2_ENDPOINT,
};
const objectPrefix = `hls/${lookupPath}`;
console.log(`Envoi vers R2 : ${objectPrefix}`);
await run('/opt/homebrew/bin/rclone', ['copy', outputDirectory, `WEFLIXR2:${localEnv.R2_BUCKET}/${objectPrefix}`, '--progress'], { env: rcloneEnv });

const probe = await new Promise((done, reject) => {
  const child = spawn('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath], { stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.once('error', reject);
  child.once('close', (code) => code === 0 ? done(output) : reject(new Error('ffprobe a échoué.')));
});
const manifest = `${JSON.stringify({ key: `${objectPrefix}/index.m3u8`, title: titleArgument, duration: Number.parseFloat(probe.trim()), format: 'hls', updatedAt: new Date().toISOString() }, null, 2)}\n`;
await new Promise((done, reject) => {
  const child = spawn('/opt/homebrew/bin/rclone', ['rcat', `WEFLIXR2:${localEnv.R2_BUCKET}/catalog/${lookupPath}.json`], { env: rcloneEnv, stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(manifest);
  child.once('error', reject);
  child.once('close', (code) => code === 0 ? done() : reject(new Error('Écriture du manifeste R2 impossible.')));
});
console.log(`HLS prêt : ${lookupPath}`);
console.log(`Dossier temporaire à supprimer après vérification : ${outputDirectory}`);
