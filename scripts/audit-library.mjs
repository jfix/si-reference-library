import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = '/Users/jakob/Projects/si-reference-library';
const REFERENCES_DIR = path.join(ROOT, 'references');
const METADATA_PLACES_PATH = path.join(ROOT, 'metadata', 'places.json');
const SCRAPED_CITIES_PATH = path.join(ROOT, 'data', 'cities.json');
const OUTPUT_DIR = path.join(ROOT, 'data', 'audits');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'reference-library-audit.json');

const LIVE_ROOT = process.env.LIVE_DATA_ROOT ?? '/Users/jakob/Projects/collect-si-live-data';
const LIVE_EVENTS_DIR = path.join(LIVE_ROOT, 'data');
const LIVE_PLACE_MAPPINGS_PATH = path.join(LIVE_ROOT, 'place-mappings.json');

async function main() {
  const [places, scrapedCities, livePlaceMappings] = await Promise.all([
    readJson(METADATA_PLACES_PATH, {}),
    readJson(SCRAPED_CITIES_PATH, { cities: [] }),
    readJson(LIVE_PLACE_MAPPINGS_PATH, {}),
  ]);

  const referenceScan = await scanReferences();
  const liveFeed = await scanLiveFeed(livePlaceMappings);

  const report = buildAuditReport({
    places,
    scrapedCities,
    livePlaceMappings,
    referenceScan,
    liveFeed,
  });

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await writeJson(OUTPUT_PATH, report);

  console.log(JSON.stringify({
    report: OUTPUT_PATH,
    summary: report.summary,
    top_missing_live_cities: report.priorities.missing_live_city_coverage.slice(0, 10),
    top_weak_cities: report.priorities.weak_existing_city_coverage.slice(0, 10),
    top_invader_issues: report.priorities.invaders_needing_attention.slice(0, 10),
  }, null, 2));
}

async function scanReferences() {
  const placeIds = (await safeReadDir(REFERENCES_DIR)).filter((entry) => !entry.startsWith('.'));
  const byCity = new Map();
  const invaderIssues = [];

  for (const placeId of placeIds) {
    const cityDir = path.join(REFERENCES_DIR, placeId);
    const entries = await safeReadDir(cityDir);
    const invaderDirs = entries.filter((entry) => /^[A-Z0-9]+_\d+$/.test(entry));
    const cityStats = {
      place_id: placeId,
      invader_count: 0,
      confirmed_count: 0,
      identifier_only_count: 0,
      usable_reference_count: 0,
      grosplan_only_count: 0,
      missing_metadata_count: 0,
      image_count: 0,
      missing_image_file_count: 0,
      invalid_invader_ids: [],
      issue_count: 0,
    };

    for (const invaderId of invaderDirs) {
      const invaderDir = path.join(cityDir, invaderId);
      const metadataPath = path.join(invaderDir, 'metadata.json');
      cityStats.invader_count += 1;

      let metadata;
      try {
        metadata = await readJson(metadataPath);
      } catch {
        cityStats.missing_metadata_count += 1;
        cityStats.issue_count += 1;
        invaderIssues.push(issue(invaderId, placeId, 'error', 'missing_metadata', 'metadata.json is missing or unreadable'));
        continue;
      }

      if (metadata.invader_id !== invaderId) {
        cityStats.issue_count += 1;
        invaderIssues.push(issue(invaderId, placeId, 'error', 'invader_id_mismatch', `metadata.invader_id=${metadata.invader_id ?? '<missing>'}`));
      }

      if (metadata.place_id !== placeId) {
        cityStats.issue_count += 1;
        invaderIssues.push(issue(invaderId, placeId, 'error', 'place_id_mismatch', `metadata.place_id=${metadata.place_id ?? '<missing>'}`));
      }

      const status = metadata.status ?? '<missing>';
      if (status === 'confirmed') cityStats.confirmed_count += 1;
      if (status === 'identifier-only') cityStats.identifier_only_count += 1;
      if (!metadata.status) {
        cityStats.issue_count += 1;
        invaderIssues.push(issue(invaderId, placeId, 'warning', 'missing_status', 'metadata.status is missing'));
      }
      const isInvisible = status === 'invisible';

      const images = Array.isArray(metadata.images) ? metadata.images : [];
      let hasUsableReference = false;
      let hasPositiveImage = false;
      let hasGrosplan = false;

      if (images.length === 0 && !isInvisible) {
        cityStats.issue_count += 1;
        invaderIssues.push(issue(invaderId, placeId, 'error', 'no_images', 'metadata.images is empty'));
      }

      for (const image of images) {
        cityStats.image_count += 1;
        const role = image.role ?? null;
        const containsInvader = image.contains_invader;
        if (containsInvader === true) {
          hasPositiveImage = true;
        }
        if (role === 'grosplan' && containsInvader === true) {
          hasGrosplan = true;
        }
        if (containsInvader === true && role !== 'grosplan') {
          hasUsableReference = true;
        }
        if (!role) {
          cityStats.issue_count += 1;
          invaderIssues.push(issue(invaderId, placeId, 'warning', 'missing_role', 'an image is missing role'));
        }
        if (containsInvader === undefined) {
          cityStats.issue_count += 1;
          invaderIssues.push(issue(invaderId, placeId, 'warning', 'missing_contains_invader', 'an image is missing contains_invader'));
        }

        const localPath = image.local_path;
        const remoteUrl = image.url ?? image.preview_url ?? null;
        if (!localPath && !remoteUrl) {
          cityStats.issue_count += 1;
          invaderIssues.push(issue(invaderId, placeId, 'warning', 'missing_asset_locator', 'an image is missing both local_path and url'));
          continue;
        }

        if (!localPath) {
          continue;
        }

        const absoluteImagePath = path.join(ROOT, localPath);
        if (!(await pathExists(absoluteImagePath))) {
          cityStats.missing_image_file_count += 1;
          cityStats.issue_count += 1;
          invaderIssues.push(issue(invaderId, placeId, 'error', 'missing_image_file', localPath));
        }
      }

      if (hasUsableReference) cityStats.usable_reference_count += 1;
      if (!hasUsableReference && hasGrosplan) cityStats.grosplan_only_count += 1;

      if (!hasPositiveImage && !isInvisible) {
        cityStats.issue_count += 1;
        invaderIssues.push(issue(invaderId, placeId, 'error', 'no_positive_image', 'no image with contains_invader=true'));
      }
      if (!hasUsableReference && !isInvisible) {
        cityStats.issue_count += 1;
        invaderIssues.push(issue(invaderId, placeId, 'warning', 'no_usable_reference', 'only grosplan or non-positive assets available'));
      }
    }

    cityStats.coverage_ratio = ratio(cityStats.invader_count, cityStats.invader_count);
    cityStats.usable_reference_ratio = ratio(cityStats.usable_reference_count, cityStats.invader_count);
    byCity.set(placeId, cityStats);
  }

  return {
    byCity,
    invaderIssues,
  };
}

async function scanLiveFeed(livePlaceMappings) {
  const cityCounts = new Map();
  const unknownCities = new Map();
  const dayDirs = await safeReadDir(LIVE_EVENTS_DIR);

  for (const dayDir of dayDirs.filter((entry) => /^\d{8}$/.test(entry))) {
    const hourFiles = await safeReadDir(path.join(LIVE_EVENTS_DIR, dayDir));
    for (const hourFile of hourFiles.filter((entry) => entry.endsWith('.ndjson'))) {
      const content = await fs.readFile(path.join(LIVE_EVENTS_DIR, dayDir, hourFile), 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const cityName = typeof event.city === 'string' ? event.city.trim() : '';
        if (!cityName) continue;
        const placeId = resolvePlaceId(cityName, livePlaceMappings);
        if (!placeId) {
          unknownCities.set(cityName, (unknownCities.get(cityName) ?? 0) + 1);
          continue;
        }
        cityCounts.set(placeId, (cityCounts.get(placeId) ?? 0) + 1);
      }
    }
  }

  return {
    total_events_with_resolved_place_id: Array.from(cityCounts.values()).reduce((sum, count) => sum + count, 0),
    cityCounts,
    unknownCities: Array.from(unknownCities.entries())
      .map(([city, events]) => ({ city, events }))
      .sort((a, b) => b.events - a.events),
  };
}

function buildAuditReport({ places, scrapedCities, livePlaceMappings, referenceScan, liveFeed }) {
  const scrapedByCode = new Map((scrapedCities.cities ?? []).map((row) => [row.code, row]));
  const placeCodes = new Set(Object.keys(places));
  const referenceCodes = new Set(referenceScan.byCity.keys());
  const liveMappingCodes = new Set(Object.keys(livePlaceMappings));

  const missingFromReferences = Array.from(scrapedByCode.values())
    .filter((row) => !referenceCodes.has(row.code))
    .map((row) => ({
      code: row.code,
      city: row.city,
      total_count: row.totalCount,
      found_count: row.foundCount,
      has_place_metadata: placeCodes.has(row.code),
      live_events: liveFeed.cityCounts.get(row.code) ?? 0,
    }))
    .sort((a, b) => b.live_events - a.live_events || b.total_count - a.total_count || a.code.localeCompare(b.code));

  const referenceCitiesMissingPlaceMetadata = Array.from(referenceCodes)
    .filter((code) => !placeCodes.has(code))
    .map((code) => ({
      code,
      reference_invaders: referenceScan.byCity.get(code)?.invader_count ?? 0,
      live_events: liveFeed.cityCounts.get(code) ?? 0,
    }))
    .sort((a, b) => b.live_events - a.live_events || b.reference_invaders - a.reference_invaders || a.code.localeCompare(b.code));

  const placeMetadataWithoutReferenceCity = Array.from(placeCodes)
    .filter((code) => !referenceCodes.has(code))
    .map((code) => ({
      code,
      city: places[code]?.city ?? null,
      target_count: places[code]?.target_count ?? null,
      live_events: liveFeed.cityCounts.get(code) ?? 0,
    }))
    .sort((a, b) => b.live_events - a.live_events || (b.target_count ?? 0) - (a.target_count ?? 0) || a.code.localeCompare(b.code));

  const weakExistingCities = Array.from(referenceScan.byCity.values())
    .map((row) => {
      const scraped = scrapedByCode.get(row.place_id);
      const targetCount = places[row.place_id]?.target_count ?? scraped?.totalCount ?? row.invader_count;
      return {
        place_id: row.place_id,
        city: places[row.place_id]?.city ?? scraped?.city ?? null,
        reference_invaders: row.invader_count,
        target_count: targetCount,
        usable_reference_count: row.usable_reference_count,
        live_events: liveFeed.cityCounts.get(row.place_id) ?? 0,
        issue_count: row.issue_count,
        completion_ratio: ratio(row.invader_count, targetCount),
        usable_reference_ratio: ratio(row.usable_reference_count, row.invader_count),
        missing_invaders: Math.max(0, targetCount - row.invader_count),
      };
    })
    .filter((row) => row.missing_invaders > 0 || row.usable_reference_ratio < 1 || row.issue_count > 0)
    .sort((a, b) =>
      b.live_events - a.live_events ||
      b.missing_invaders - a.missing_invaders ||
      a.usable_reference_ratio - b.usable_reference_ratio ||
      b.issue_count - a.issue_count ||
      a.place_id.localeCompare(b.place_id),
    );

  const liveCoveredEvents = Array.from(liveFeed.cityCounts.entries()).reduce((sum, [placeId, count]) => {
    return sum + (referenceCodes.has(placeId) ? count : 0);
  }, 0);

  const invadersNeedingAttention = groupInvaderIssues(referenceScan.invaderIssues);

  return {
    generated_at: new Date().toISOString(),
    paths: {
      root: ROOT,
      live_root: LIVE_ROOT,
      references_dir: REFERENCES_DIR,
      output_path: OUTPUT_PATH,
    },
    summary: {
      scraped_city_count: scrapedByCode.size,
      place_metadata_city_count: placeCodes.size,
      reference_city_count: referenceCodes.size,
      live_mapping_city_count: liveMappingCodes.size,
      reference_invader_count: Array.from(referenceScan.byCity.values()).reduce((sum, row) => sum + row.invader_count, 0),
      live_events_with_resolved_place_id: liveFeed.total_events_with_resolved_place_id,
      live_events_coverable_by_current_references: liveCoveredEvents,
      live_event_coverage_ratio: ratio(liveCoveredEvents, liveFeed.total_events_with_resolved_place_id),
      missing_scraped_cities_in_references: missingFromReferences.length,
      reference_cities_missing_place_metadata: referenceCitiesMissingPlaceMetadata.length,
      place_metadata_without_reference_city: placeMetadataWithoutReferenceCity.length,
      invaders_with_issues: invadersNeedingAttention.length,
    },
    coverage: {
      missing_scraped_cities_in_references: missingFromReferences,
      reference_cities_missing_place_metadata: referenceCitiesMissingPlaceMetadata,
      place_metadata_without_reference_city: placeMetadataWithoutReferenceCity,
      weak_existing_city_coverage: weakExistingCities,
      reference_city_stats: Array.from(referenceScan.byCity.values()).sort((a, b) => a.place_id.localeCompare(b.place_id)),
    },
    live_feed_overlap: {
      top_live_cities: Array.from(liveFeed.cityCounts.entries())
        .map(([place_id, live_events]) => ({
          place_id,
          city: livePlaceMappings[place_id]?.name ?? places[place_id]?.city ?? null,
          live_events,
          has_reference_city: referenceCodes.has(place_id),
          reference_invaders: referenceScan.byCity.get(place_id)?.invader_count ?? 0,
        }))
        .sort((a, b) => b.live_events - a.live_events)
        .slice(0, 100),
      unknown_live_cities: liveFeed.unknownCities.slice(0, 50),
    },
    quality: {
      invaders_needing_attention: invadersNeedingAttention,
      issue_counts_by_code: countBy(referenceScan.invaderIssues, (item) => item.code),
      issue_counts_by_severity: countBy(referenceScan.invaderIssues, (item) => item.severity),
    },
    priorities: {
      missing_live_city_coverage: missingFromReferences.filter((row) => row.live_events > 0).slice(0, 50),
      weak_existing_city_coverage: weakExistingCities.filter((row) => row.live_events > 0).slice(0, 50),
      invaders_needing_attention: invadersNeedingAttention.slice(0, 100),
    },
  };
}

function groupInvaderIssues(issues) {
  const grouped = new Map();
  for (const row of issues) {
    const key = `${row.place_id}:${row.invader_id}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        place_id: row.place_id,
        invader_id: row.invader_id,
        severities: new Set(),
        codes: new Set(),
        details: [],
      });
    }
    const current = grouped.get(key);
    current.severities.add(row.severity);
    current.codes.add(row.code);
    current.details.push({ severity: row.severity, code: row.code, detail: row.detail });
  }

  return Array.from(grouped.values())
    .map((row) => ({
      place_id: row.place_id,
      invader_id: row.invader_id,
      severity: row.severities.has('error') ? 'error' : 'warning',
      issue_count: row.details.length,
      codes: Array.from(row.codes).sort(),
      details: row.details,
    }))
    .sort((a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      b.issue_count - a.issue_count ||
      a.invader_id.localeCompare(b.invader_id),
    );
}

function resolvePlaceId(cityName, livePlaceMappings) {
  for (const [placeId, row] of Object.entries(livePlaceMappings)) {
    if (row.name === cityName || row.variation === cityName) {
      return placeId;
    }
  }
  return null;
}

function issue(invaderId, placeId, severity, code, detail) {
  return {
    invader_id: invaderId,
    place_id: placeId,
    severity,
    code,
    detail,
  };
}

function severityRank(severity) {
  return severity === 'error' ? 0 : 1;
}

function countBy(rows, keyFn) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))));
}

function ratio(numerator, denominator) {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(4));
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (fallback !== null) {
      return fallback;
    }
    throw error;
  }
}

async function safeReadDir(dirPath) {
  try {
    return await fs.readdir(dirPath);
  } catch {
    return [];
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(filePath, payload) {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
