const original = require('./search-original');
const config = require('../../config');
const logger = require('../../config/logger');
const { path, fs, isExistingDirectory } = require('./utils');
const { passesFilters, checkExtensionFilter } = require('./filters');

const normalizedStem = (filename) => path.basename(filename, path.extname(filename))
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/\b(?:www|com|org|net|torrent|oxtorrent|uindex)\b/g, '')
  .replace(/[^a-z0-9]+/g, '');

const significantTokens = (filename) => path.basename(filename, path.extname(filename))
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .split(/[^a-z0-9]+/)
  .filter((token) => token.length > 1 && !/^(?:www|com|org|net|torrent|oxtorrent|uindex|eac3|ddp|aac|ac3|atmos|[257]1|6ch|8ch|10bit)$/.test(token));

const fuzzyMatch = (candidate, expected) => {
  if (path.extname(candidate).toLowerCase() !== path.extname(expected).toLowerCase()) return false;
  const candidateStem = normalizedStem(candidate);
  const expectedStem = normalizedStem(expected);
  if (candidateStem.length < 12 || expectedStem.length < 12) return false;
  if (candidateStem === expectedStem
    || candidateStem.includes(expectedStem)
    || expectedStem.includes(candidateStem)) return true;
  const candidateTokens = new Set(significantTokens(candidate));
  const expectedTokens = new Set(significantTokens(expected));
  const smallerSize = Math.min(candidateTokens.size, expectedTokens.size);
  if (smallerSize < 5) return false;
  const common = [...candidateTokens].filter((token) => expectedTokens.has(token)).length;
  return common / smallerSize >= 0.8;
};

const findFuzzyRecursive = async (directory, filename, depth, maxDepth) => {
  if (depth > maxDepth || !await isExistingDirectory(directory)) return null;
  let names;
  try { names = await fs.readdir(directory); } catch { return null; }
  const directories = [];
  for (const name of names) {
    const candidatePath = path.join(directory, name);
    let stats;
    try { stats = await fs.stat(candidatePath); } catch { continue; }
    if (stats.isDirectory()) {
      directories.push({ path: candidatePath, modified: stats.mtimeMs });
    } else if (fuzzyMatch(name, filename) && await passesFilters(candidatePath, name)) {
      return candidatePath;
    }
  }
  directories.sort((a, b) => b.modified - a.modified);
  for (const child of directories) {
    const found = await findFuzzyRecursive(child.path, filename, depth + 1, maxDepth);
    if (found) return found;
  }
  return null;
};

const findFileWithRetries = async (...args) => {
  const exact = await original.findFileWithRetries(...args);
  if (exact.path || exact.filteredReason) return exact;
  const [baseDir, filename] = args;
  const extension = checkExtensionFilter(filename);
  if (!extension.passExtensionFilter) return { path: null, filteredReason: extension.reason };
  const found = await findFuzzyRecursive(baseDir, filename, 0, config.fileOperations?.maxSearchDepth || 5);
  if (found) {
    logger.info(`Fuzzy filename match: ${filename} -> ${found}`);
    return { path: found };
  }
  return exact;
};

module.exports = {
  ...original,
  findFileWithRetries,
};
