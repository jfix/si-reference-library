import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE_URL = 'https://www.invader-spotter.art/';
const CITY_INDEX_URL = new URL('villes.php', BASE_URL).href;
const LISTING_URL = new URL('listing.php', BASE_URL).href;
const CITY_INDEX_PATH = path.join(ROOT, 'data', 'cities.json');
const CITY_OUTPUT_DIR = path.join(ROOT, 'data', 'cities');
const PLACE_METADATA_PATH = path.join(ROOT, 'metadata', 'places.json');
const REFERENCES_DIR = path.join(ROOT, 'references');
const PAGE_SIZE = 50;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cityIndex = await loadJson(CITY_INDEX_PATH).catch(() => null);
  const placeMetadata = await loadJson(PLACE_METADATA_PATH).catch(() => ({}));
  const placeEntry = placeMetadata[options.code] ?? null;
  const cityIndexEntry = cityIndex?.cities?.find((entry) => entry.code === options.code) ?? null;
  const targetCount = cityIndexEntry?.totalCount ?? placeEntry?.target_count ?? null;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    const pages = [];
    const seenIds = new Set();
    let totalInvaders = targetCount;
    let cityName = cityIndexEntry?.city ?? placeEntry?.city ?? null;
    let citySummary = null;
    const discoveredMaxPages = targetCount ? Math.ceil(targetCount / PAGE_SIZE) : 25;
    const startPage = options.startPage;
    const maxPages = Math.min(discoveredMaxPages, options.maxPages ? startPage + options.maxPages - 1 : discoveredMaxPages);

    for (let pageNumber = startPage; pageNumber <= maxPages; pageNumber += 1) {
      console.log(`Fetching ${options.code} page ${pageNumber}/${discoveredMaxPages}`);
      const pageResult = await fetchCityPage(page, options.code, pageNumber);
      if (pageResult.invaders.length === 0) {
        break;
      }

      pages.push(pageResult);
      totalInvaders ??= pageResult.totalInvaders;
      cityName ??= pageResult.city;
      citySummary ??= {
        city: pageResult.city,
        code: pageResult.code,
        invasionWaves: pageResult.invasionWaves,
        totalInvaders: pageResult.totalInvaders,
        totalPoints: pageResult.totalPoints,
        listingUrl: pageResult.listingUrl,
      };

      const before = seenIds.size;
      for (const invader of pageResult.invaders) {
        seenIds.add(invader.invaderId);
      }

      if (seenIds.size === before) {
        break;
      }

      if (totalInvaders && seenIds.size >= totalInvaders) {
        break;
      }
    }

    const invaders = dedupeInvaders(pages.flatMap((result) => result.invaders));
    const output = {
      source: BASE_URL,
      scrapedAt: new Date().toISOString(),
      city: cityName,
      code: options.code,
      totalInvaders: totalInvaders ?? invaders.length,
      pagesScraped: pages.length,
      summary: citySummary,
      invaders,
    };

    await fs.mkdir(CITY_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(CITY_OUTPUT_DIR, `${options.code}.json`);
    const existingOutput = await loadJson(outputPath).catch(() => null);
    if (invaders.length === 0 && existingOutput?.invaders?.length > 0) {
      throw new Error(`Refusing to overwrite ${outputPath} with zero invaders; keeping existing scrape output`);
    }
    const mergedOutput = mergeCityOutput(existingOutput, output);
    await fs.writeFile(outputPath, `${JSON.stringify(mergedOutput, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${mergedOutput.invaders.length} invaders to ${outputPath}`);

    if (options.syncReferences) {
      await syncReferences({
        cityData: mergedOutput,
        placeEntry,
        downloadImages: options.downloadImages,
      });
    }
  } finally {
    await page.close();
    await browser.close();
  }
}

function parseArgs(args) {
  const options = {
    code: null,
    syncReferences: false,
    downloadImages: false,
    startPage: 1,
    maxPages: null,
  };

  for (const arg of args) {
    if (!options.code && !arg.startsWith('--')) {
      options.code = arg.toUpperCase();
      continue;
    }

    if (arg === '--sync-references') {
      options.syncReferences = true;
      continue;
    }

    if (arg === '--download-images') {
      options.downloadImages = true;
      continue;
    }

    if (arg.startsWith('--start-page=')) {
      options.startPage = parsePositiveInteger(arg.split('=')[1], '--start-page');
      continue;
    }

    if (arg.startsWith('--max-pages=')) {
      options.maxPages = parsePositiveInteger(arg.split('=')[1], '--max-pages');
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.code) {
    throw new Error('Usage: npm run scrape:city -- <CITY_CODE> [--sync-references] [--download-images]');
  }

  return options;
}

function parsePositiveInteger(value, flagName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return parsed;
}

async function fetchCityPage(page, code, pageNumber) {
  await page.goto(CITY_INDEX_URL, { waitUntil: 'networkidle' });
  await page.evaluate(
    ({ cityCode, pageValue, pageSize }) => {
      const form = document.forms.recherche ?? document.querySelector('form[name="recherche"]');
      if (!form) {
        throw new Error('City search form not found');
      }

      const ensureHidden = (name, value) => {
        let input = form.querySelector(`input[name="${name}"]`);
        if (!input) {
          input = document.createElement('input');
          input.type = 'hidden';
          input.name = name;
          form.appendChild(input);
        }
        input.value = String(value);
      };

      ensureHidden('ville', cityCode);
      ensureHidden('arron', '00');
      ensureHidden('mode', 'lst');
      ensureHidden('rang', String(pageSize));
      ensureHidden('page', String(pageValue));
      form.submit();
    },
    { cityCode: code, pageValue: pageNumber, pageSize: PAGE_SIZE },
  );

  await page.waitForURL((url) => url.href.includes('listing.php'));
  await page.waitForLoadState('networkidle');

  return page.evaluate(({ baseUrl }) => {
    const normalize = (value) => value.replace(/\s+/g, ' ').trim();
    const resolve = (value) => new URL(value, baseUrl).href;
    const bodyText = document.body.innerText;
    const summaryMatch = bodyText.match(
      /^([^\n]+?) \(([A-Z0-9_]+)\)\s+(\d+)\s+vague(?:s)? d'invasion\s*-\s*(\d+)\s+invaders\s*-\s*(\d+)\s+points/m,
    );

    const invaders = Array.from(document.querySelectorAll('tr.haut'))
      .map((topRow) => {
        const captionRow = topRow.nextElementSibling;
        const metaCell = topRow?.querySelector('td[rowspan]');
        if (!topRow || !metaCell) {
          return null;
        }

        const lines = metaCell.innerText
          .split('\n')
          .map(normalize)
          .filter(Boolean);
        const idMatch = lines[0]?.match(/^([A-Z0-9_]+)\s+\[(\d+)\s+pts\]$/);
        if (!idMatch) {
          return null;
        }

        const photoLinks = Array.from(topRow.querySelectorAll('a.chocolat-image'));
        const captionCells = Array.from(captionRow?.querySelectorAll('td') ?? [])
          .map((cell) => normalize(cell.innerText))
          .filter(Boolean);
        const leftImage = metaCell.querySelector('img');
        const instagramLink = metaCell.querySelector('a[href*="instagram.com"]');

        return {
          invaderId: idMatch[1],
          points: Number.parseInt(idMatch[2], 10),
          poseDate: lines.find((line) => line.startsWith('Date de pose :'))?.replace(/^Date de pose :\s*/, '') ?? null,
          lastKnownState:
            lines.find((line) => line.startsWith("Dernier état connu :"))?.replace(/^Dernier état connu :\s*/, '') ?? null,
          lastSeenSource:
            lines.find((line) => line.startsWith('Date et source :'))?.replace(/^Date et source :\s*/, '') ?? null,
          instagramUrl: instagramLink ? resolve(instagramLink.getAttribute('href')) : null,
          thumbnailUrl: leftImage ? resolve(leftImage.getAttribute('src')) : null,
          photos: photoLinks.map((link, index) => ({
            fullUrl: resolve(link.getAttribute('href')),
            previewUrl: resolve(link.querySelector('img')?.getAttribute('src') ?? link.getAttribute('href')),
            title: link.getAttribute('title') ?? null,
            caption: captionCells[index] ?? null,
          })),
        };
      })
      .filter(Boolean);

    return {
      listingUrl: location.href,
      city: summaryMatch?.[1] ?? null,
      code: summaryMatch?.[2] ?? null,
      invasionWaves: summaryMatch ? Number.parseInt(summaryMatch[3], 10) : null,
      totalInvaders: summaryMatch ? Number.parseInt(summaryMatch[4], 10) : null,
      totalPoints: summaryMatch ? Number.parseInt(summaryMatch[5], 10) : null,
      invaders,
    };
  }, { baseUrl: BASE_URL });
}

function dedupeInvaders(invaders) {
  const byId = new Map();

  for (const invader of invaders) {
    if (!invader?.invaderId) {
      continue;
    }

    if (!byId.has(invader.invaderId)) {
      byId.set(invader.invaderId, structuredClone(invader));
      continue;
    }

    const existing = byId.get(invader.invaderId);
    existing.photos = dedupeObjects([...existing.photos, ...invader.photos], (photo) => photo.fullUrl);
    existing.thumbnailUrl ??= invader.thumbnailUrl;
    existing.instagramUrl ??= invader.instagramUrl;
    existing.lastSeenSource ??= invader.lastSeenSource;
    existing.lastKnownState ??= invader.lastKnownState;
    existing.poseDate ??= invader.poseDate;
    existing.points ??= invader.points;
  }

  return Array.from(byId.values()).sort((a, b) => a.invaderId.localeCompare(b.invaderId));
}

function mergeCityOutput(existingOutput, freshOutput) {
  if (!existingOutput) {
    return freshOutput;
  }

  return {
    source: freshOutput.source ?? existingOutput.source,
    scrapedAt: freshOutput.scrapedAt,
    city: freshOutput.city ?? existingOutput.city ?? null,
    code: freshOutput.code ?? existingOutput.code,
    totalInvaders: freshOutput.totalInvaders ?? existingOutput.totalInvaders ?? null,
    pagesScraped: Math.max(existingOutput.pagesScraped ?? 0, freshOutput.pagesScraped ?? 0),
    summary: freshOutput.summary ?? existingOutput.summary ?? null,
    invaders: dedupeInvaders([...(existingOutput.invaders ?? []), ...(freshOutput.invaders ?? [])]),
  };
}

async function syncReferences({ cityData, placeEntry, downloadImages }) {
  const placeDir = path.join(REFERENCES_DIR, cityData.code);
  await fs.mkdir(placeDir, { recursive: true });

  for (const invader of cityData.invaders) {
    const invaderDir = path.join(placeDir, invader.invaderId);
    const imagesDir = path.join(invaderDir, 'images');
    const metadataPath = path.join(invaderDir, 'metadata.json');
    await fs.mkdir(imagesDir, { recursive: true });

    const existing = await loadJson(metadataPath).catch(() => ({}));
    const images = [];

    if (invader.thumbnailUrl) {
      const thumbnailRecord = {
        type: 'invader-spotter-grosplan',
        url: invader.thumbnailUrl,
        role: 'grosplan',
        contains_invader: true,
      };

      if (downloadImages) {
        const filename = path.basename(new URL(invader.thumbnailUrl).pathname);
        const localPath = path.join(imagesDir, filename);
        const downloaded = await tryDownloadFile(invader.thumbnailUrl, localPath, invader.invaderId, 'grosplan');
        if (downloaded) {
          thumbnailRecord.local_path = path.relative(ROOT, localPath);
        }
      }

      images.push(thumbnailRecord);
    }

    const isDestroyed = typeof invader.lastKnownState === 'string' && /^Détruit\b/i.test(invader.lastKnownState.trim());
    const emptySceneIndex = isDestroyed && invader.photos.length > 1 ? invader.photos.length - 1 : -1;

    for (const [index, photo] of invader.photos.entries()) {
      const isEmptyScene = index === emptySceneIndex;
      const imageRecord = {
        type: 'invader-spotter-photo',
        url: photo.fullUrl,
        preview_url: photo.previewUrl,
        caption: photo.caption,
        title: photo.title,
        role: isEmptyScene ? 'status-empty-scene' : 'reference',
        contains_invader: !isEmptyScene,
      };

      if (downloadImages) {
        const filename = path.basename(new URL(photo.fullUrl).pathname);
        const localPath = path.join(imagesDir, filename);
        const downloaded = await tryDownloadFile(photo.fullUrl, localPath, invader.invaderId, 'photo');
        if (downloaded) {
          imageRecord.local_path = path.relative(ROOT, localPath);
        }
      }

      images.push(imageRecord);
    }

    const sourceRecords = dedupeObjects(
      [
        ...(existing.sources ?? []),
        {
          type: 'invader-spotter-listing',
          url: cityData.summary?.listingUrl ?? LISTING_URL,
          label: `${cityData.code} listing page`,
        },
        ...(invader.instagramUrl
          ? [
              {
                type: 'instagram-tag',
                url: invader.instagramUrl,
                label: `Instagram hashtag for ${invader.invaderId}`,
              },
            ]
          : []),
      ],
      (entry) => `${entry.type}::${entry.url}`,
    );

    const mergedImages = mergeImageEntries(existing.images ?? [], images);
    const metadata = {
      place_id: cityData.code,
      invader_id: invader.invaderId,
      city: cityData.city ?? existing.city ?? placeEntry?.city ?? null,
      country: existing.country ?? placeEntry?.country ?? null,
      status: existing.status ?? 'confirmed',
      points: invader.points ?? existing.points ?? null,
      notes: existing.notes ?? 'Scraped from invader-spotter.art listing data.',
      pose_date: invader.poseDate ?? existing.pose_date ?? null,
      last_known_state: invader.lastKnownState ?? existing.last_known_state ?? null,
      last_seen_source: invader.lastSeenSource ?? existing.last_seen_source ?? null,
      thumbnail_url: invader.thumbnailUrl ?? existing.thumbnail_url ?? null,
      sources: sourceRecords,
      images: mergedImages,
    };

    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  }

  const indexPath = path.join(placeDir, 'index.json');
  const indexPayload = {
    place_id: cityData.code,
    city: cityData.city ?? placeEntry?.city ?? null,
    country: placeEntry?.country ?? null,
    target_count: cityData.totalInvaders,
    confirmed_invaders: cityData.invaders.map((invader) => invader.invaderId),
    notes: 'Generated from invader-spotter.art city listing pages.',
  };
  await fs.writeFile(indexPath, `${JSON.stringify(indexPayload, null, 2)}\n`, 'utf8');
}

async function downloadFile(url, destinationPath) {
  try {
    await fs.access(destinationPath);
    return;
  } catch {
    // File does not exist yet.
  }

  const response = await fetch(url, {
    headers: {
      Referer: LISTING_URL,
      'User-Agent': 'si-reference-library/0.1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destinationPath, buffer);
}

async function tryDownloadFile(url, destinationPath, invaderId, assetType) {
  try {
    await downloadFile(url, destinationPath);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[warn] ${invaderId} ${assetType} download skipped: ${url} (${message})`);
    return false;
  }
}

async function loadJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function dedupeObjects(entries, keyFn) {
  const seen = new Set();
  const output = [];

  for (const entry of entries) {
    if (!entry) {
      continue;
    }

    const key = keyFn(entry);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(entry);
  }

  return output;
}

function mergeImageEntries(existingEntries, freshEntries) {
  const merged = new Map();

  for (const entry of existingEntries) {
    if (!entry) continue;
    const key = entry.url ?? entry.local_path;
    if (!key) continue;
    merged.set(key, entry);
  }

  for (const entry of freshEntries) {
    if (!entry) continue;
    const key = entry.url ?? entry.local_path;
    if (!key) continue;
    merged.set(key, entry);
  }

  return Array.from(merged.values());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
