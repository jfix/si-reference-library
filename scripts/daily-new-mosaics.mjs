import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REFERENCE_DIR = path.join(ROOT, 'references');
const CITY_INDEX_PATH = path.join(ROOT, 'data', 'cities.json');
const DEFAULT_REPORT_PATH = path.join(ROOT, 'tmp', 'daily-new-mosaics-report.json');
const PAGE_SIZE = 50;
const DELTA_SAFETY_INVADERS = 20;

const options = parseArgs(process.argv.slice(2));

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  const cityIndexResult = await runCommandWithRetries(process.execPath, [path.join(ROOT, 'scripts', 'scrape-cities.mjs')], {
    retries: 2,
    backoffMs: 2000,
  });

  if (!cityIndexResult.ok) {
    throw new Error(`Failed to refresh city index: ${cityIndexResult.error}`);
  }

  const cityIndex = await readJson(CITY_INDEX_PATH);
  const localCityStats = await scanLocalCityStats();
  const candidateCities = selectCandidateCities(cityIndex.cities ?? [], localCityStats, options.fullScan);

  const cityDeltas = [];
  const newInvaders = [];
  const skippedNewInvaders = [];
  const failedCities = [];

  for (const city of candidateCities) {
    const before = await readInvaderIds(city.code);
    const scrapeArgs = [
      path.join(ROOT, 'scripts', 'scrape-city.mjs'),
      city.code,
      '--sync-references',
      '--download-images',
      `--start-page=${city.scrapePlan.startPage}`,
    ];

    if (city.scrapePlan.maxPages !== null) {
      scrapeArgs.push(`--max-pages=${city.scrapePlan.maxPages}`);
    }

    const scrapeResult = await runCommandWithRetries(process.execPath, scrapeArgs, {
      retries: 2,
      backoffMs: 2000,
    });

    if (!scrapeResult.ok) {
      failedCities.push({
        code: city.code,
        city: city.city,
        reference_count: before.size,
        spotter_count: city.totalCount ?? null,
        scrape_plan: city.scrapePlan,
        error: scrapeResult.error,
      });
      continue;
    }

    const after = await readInvaderIds(city.code);
    const added = Array.from(after).filter((invaderId) => !before.has(invaderId)).sort((a, b) => a.localeCompare(b));

    cityDeltas.push({
      code: city.code,
      city: city.city,
      reference_count: before.size,
      highest_known_suffix: city.localStats.highestKnownSuffix,
      spotter_count: city.totalCount ?? null,
      delta: Math.max(0, (city.totalCount ?? 0) - before.size),
      scrape_plan: city.scrapePlan,
      new_invader_ids: added,
    });

    for (const invaderId of added) {
      const metadataPath = path.join(REFERENCE_DIR, city.code, invaderId, 'metadata.json');
      const metadata = await readJson(metadataPath).catch(() => null);
      if (!metadata) {
        skippedNewInvaders.push({
          code: city.code,
          city: city.city,
          invader_id: invaderId,
          reason: 'missing_metadata',
        });
        continue;
      }

      const grosplanImage = findGrosplanImage(metadata, invaderId);
      if (!grosplanImage?.local_path) {
        skippedNewInvaders.push({
          code: city.code,
          city: metadata.city ?? city.city ?? null,
          invader_id: invaderId,
          reason: 'missing_grosplan_image',
        });
        continue;
      }

      newInvaders.push({
        code: city.code,
        city: metadata.city ?? city.city ?? null,
        invader_id: invaderId,
        reference_dir: relativePath(path.join(REFERENCE_DIR, city.code, invaderId)),
        metadata_path: relativePath(metadataPath),
        grosplan_local_path: grosplanImage.local_path,
        grosplan_url: grosplanImage.url ?? null,
      });
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    source: 'https://www.invader-spotter.art/',
    full_scan: options.fullScan,
    scraped_city_count: (cityIndex.cities ?? []).length,
    candidate_city_count: candidateCities.length,
    city_deltas: cityDeltas,
    new_invader_count: newInvaders.length,
    skipped_new_invader_count: skippedNewInvaders.length,
    failed_city_count: failedCities.length,
    new_invaders: newInvaders,
    skipped_new_invaders: skippedNewInvaders,
    failed_cities: failedCities,
  };

  await writeJson(options.reportPath, report);

  console.log(JSON.stringify({
    report: options.reportPath,
    scraped_city_count: report.scraped_city_count,
    candidate_city_count: report.candidate_city_count,
    new_invader_count: report.new_invader_count,
    skipped_new_invader_count: report.skipped_new_invader_count,
    failed_city_count: report.failed_city_count,
    new_invaders: report.new_invaders.map((entry) => entry.invader_id),
    failed_cities: report.failed_cities.map((entry) => entry.code),
  }, null, 2));
}

function parseArgs(args) {
  const options = {
    fullScan: false,
    reportPath: DEFAULT_REPORT_PATH,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--full-scan') {
      options.fullScan = true;
      continue;
    }

    if (arg.startsWith('--report-path=')) {
      options.reportPath = path.resolve(process.cwd(), arg.split('=')[1]);
      continue;
    }

    if (arg === '--report-path') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--report-path requires a value');
      }
      options.reportPath = path.resolve(process.cwd(), value);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function selectCandidateCities(cities, localCityStats, fullScan) {
  const candidates = [];

  for (const city of cities) {
    if (!city?.code) {
      continue;
    }

    const localStats = localCityStats.get(city.code) ?? buildEmptyCityStats();
    const referenceCount = localStats.count;
    const spotterCount = Number.isFinite(city.totalCount) ? city.totalCount : null;

    if (fullScan || (spotterCount !== null && referenceCount < spotterCount)) {
      const scrapePlan = buildScrapePlan({
        localStats,
        spotterCount,
        fullScan,
      });

      candidates.push({
        code: city.code,
        city: city.city ?? null,
        totalCount: spotterCount,
        localStats,
        scrapePlan,
      });
    }
  }

  return candidates.sort((left, right) => {
    const leftDelta = Math.max(0, (left.totalCount ?? 0) - left.localStats.count);
    const rightDelta = Math.max(0, (right.totalCount ?? 0) - right.localStats.count);
    return rightDelta - leftDelta || (right.totalCount ?? 0) - (left.totalCount ?? 0) || left.code.localeCompare(right.code);
  });
}

async function scanLocalCityStats() {
  const stats = new Map();
  const placeIds = await safeReadDir(REFERENCE_DIR);

  for (const placeId of placeIds) {
    const placeDir = path.join(REFERENCE_DIR, placeId);
    const invaderIds = (await safeReadDir(placeDir)).filter((entry) => /^[A-Z0-9]+_\d+$/.test(entry));
    const numericSuffixes = invaderIds
      .map(parseNumericSuffix)
      .filter((value) => Number.isFinite(value));

    const highestKnownSuffix = numericSuffixes.length > 0 ? Math.max(...numericSuffixes) : 0;
    stats.set(placeId, {
      count: invaderIds.length,
      highestKnownSuffix,
      isContiguousFromOne: invaderIds.length > 0 && invaderIds.length === highestKnownSuffix,
    });
  }

  return stats;
}

async function readInvaderIds(cityCode) {
  const cityDir = path.join(REFERENCE_DIR, cityCode);
  const invaderIds = new Set();

  for (const entry of await safeReadDir(cityDir)) {
    if (/^[A-Z0-9]+_\d+$/.test(entry)) {
      invaderIds.add(entry);
    }
  }

  return invaderIds;
}

function findGrosplanImage(metadata, invaderId) {
  const images = Array.isArray(metadata?.images) ? metadata.images : [];

  for (const image of images) {
    if (image?.role === 'grosplan') {
      return normalizeImageRecord(image, metadata, invaderId);
    }
  }

  return null;
}

function normalizeImageRecord(image, metadata, invaderId) {
  if (image?.local_path) {
    return image;
  }

  if (!image?.url) {
    return null;
  }

  const filename = path.basename(new URL(image.url).pathname);
  return {
    ...image,
    local_path: path.join('references', metadata.place_id ?? derivePlaceId(invaderId), invaderId, 'images', filename),
  };
}

function derivePlaceId(invaderId) {
  return String(invaderId).split('_', 1)[0];
}

function parseNumericSuffix(invaderId) {
  const suffix = String(invaderId).split('_').at(-1);
  const parsed = Number.parseInt(suffix, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildEmptyCityStats() {
  return {
    count: 0,
    highestKnownSuffix: 0,
    isContiguousFromOne: false,
  };
}

function buildScrapePlan({ localStats, spotterCount, fullScan }) {
  if (fullScan || spotterCount === null || localStats.count === 0) {
    return {
      mode: fullScan ? 'full-scan' : 'full-city',
      startPage: 1,
      maxPages: null,
    };
  }

  if (!localStats.isContiguousFromOne || localStats.highestKnownSuffix >= spotterCount) {
    return {
      mode: 'full-city-fallback',
      startPage: 1,
      maxPages: null,
    };
  }

  const delta = spotterCount - localStats.highestKnownSuffix;
  const safeStartSuffix = Math.max(1, localStats.highestKnownSuffix - DELTA_SAFETY_INVADERS + 1);
  const safeStartPage = Math.floor((safeStartSuffix - 1) / PAGE_SIZE) + 1;
  const safeCoverage = spotterCount - safeStartSuffix + 1;

  return {
    mode: 'delta-tail-window',
    startPage: safeStartPage,
    maxPages: Math.max(1, Math.ceil(safeCoverage / PAGE_SIZE)),
    raw_delta: delta,
  };
}

function relativePath(targetPath) {
  return path.relative(ROOT, targetPath).split(path.sep).join('/');
}

async function runCommand(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      stdio: options.stdio ?? 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command failed: ${command} ${args.join(' ')}${signal ? ` (signal ${signal})` : ` (exit ${code ?? 'unknown'})`}`));
    });
  });
}

async function runCommandWithRetries(command, args, options = {}) {
  const retries = options.retries ?? 0;
  const backoffMs = options.backoffMs ?? 0;
  let attempt = 0;
  let lastError = null;

  while (attempt <= retries) {
    try {
      await runCommand(command, args, options);
      return { ok: true };
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        break;
      }

      const waitMs = backoffMs * (attempt + 1);
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    }

    attempt += 1;
  }

  return {
    ok: false,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function safeReadDir(dirPath) {
  try {
    return await fs.readdir(dirPath);
  } catch {
    return [];
  }
}