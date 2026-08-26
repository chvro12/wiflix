import { access, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const usage = `
Usage :
  npm run r2:upload -- <fichier> movie/<tmdbId> "Titre"
  npm run r2:upload -- <fichier> episode/<tmdbId>/<saison>/<episode> "Titre"
`;

const [fileArgument, lookupArgument, titleArgument] = process.argv.slice(2);
if (!fileArgument || !lookupArgument || !titleArgument) {
  console.error(usage.trim());
  process.exit(1);
}

const filePath = resolve(fileArgument);
await access(filePath);
const lookupPath = lookupArgument.replace(/^\/+|\/+$/g, '');
if (!/^(movie\/\d+|episode\/\d+\/\d+\/\d+)$/.test(lookupPath)) {
  throw new Error('Association invalide : utilisez movie/<tmdbId> ou episode/<tmdbId>/<saison>/<episode>.');
}

const rawEnv = await readFile(resolve('.env.local'), 'utf8');
const localEnv = Object.fromEntries(rawEnv.split(/\r?\n/)
  .filter((line) => line && !line.trimStart().startsWith('#') && line.includes('='))
  .map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1).replace(/^['"]|['"]$/g, '')];
  }));

for (const name of ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT', 'R2_BUCKET']) {
  if (!localEnv[name]) throw new Error(`${name} manque dans .env.local.`);
}

const ffprobe = spawnSync('/opt/homebrew/bin/ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
], { encoding: 'utf8' });
if (ffprobe.status !== 0) throw new Error('Impossible de lire la durée du média avec ffprobe.');
const duration = Number.parseFloat(ffprobe.stdout.trim());
if (!Number.isFinite(duration) || duration <= 0) throw new Error('Durée du média invalide.');

const safeName = basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '-');
const objectKey = `media/${lookupPath}/${safeName}`;
const rcloneEnv = {
  ...process.env,
  RCLONE_CONFIG_WEFLIXR2_TYPE: 's3',
  RCLONE_CONFIG_WEFLIXR2_PROVIDER: 'Cloudflare',
  RCLONE_CONFIG_WEFLIXR2_ACCESS_KEY_ID: localEnv.R2_ACCESS_KEY_ID,
  RCLONE_CONFIG_WEFLIXR2_SECRET_ACCESS_KEY: localEnv.R2_SECRET_ACCESS_KEY,
  RCLONE_CONFIG_WEFLIXR2_ENDPOINT: localEnv.R2_ENDPOINT,
};
const rclone = '/opt/homebrew/bin/rclone';

const run = (args, input) => new Promise((done, reject) => {
  const child = spawn(rclone, args, { env: rcloneEnv, stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'] });
  if (input) child.stdin.end(input);
  child.once('error', reject);
  child.once('close', (code) => code === 0 ? done() : reject(new Error(`rclone a quitté avec le code ${code}.`)));
});

console.log(`Envoi du média vers R2 : ${objectKey}`);
await run(['copyto', filePath, `WEFLIXR2:${localEnv.R2_BUCKET}/${objectKey}`, '--progress']);

const manifest = `${JSON.stringify({
  key: objectKey,
  title: titleArgument,
  duration: Math.round(duration * 1000) / 1000,
  updatedAt: new Date().toISOString(),
}, null, 2)}\n`;
await run(['rcat', `WEFLIXR2:${localEnv.R2_BUCKET}/catalog/${lookupPath}.json`], manifest);

console.log(`Association créée : ${lookupPath} → ${objectKey}`);
