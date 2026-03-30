import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = '/Users/jakob/Projects/si-reference-library';
const REFERENCES_DIR = path.join(ROOT, 'references');
const METADATA_DIR = path.join(ROOT, 'metadata');
const INVADERS_DIR = path.join(METADATA_DIR, 'invaders');
const FLASH_INDEX_PATH = path.join(ROOT, 'data', 'flash-screenshots', 'index.json');
const PLACES_PATH = path.join(METADATA_DIR, 'places.json');
const OUTPUT_PATH = path.join(METADATA_DIR, 'library-index.json');

async function main() {
  const places = await readJson(PLACES_PATH);
  const invaders = new Map();

  await loadReferenceMetadata(invaders, places);
  await loadFlashScreenshotMetadata(invaders, places);

  const records = Array.from(invaders.values()).sort((a, b) => a.invader_id.localeCompare(b.invader_id));

  await fs.mkdir(INVADERS_DIR, { recursive: true });
  for (const record of records) {
    record.summary = buildSummary(record);
    record.sources.sort((a, b) => a.source_id.localeCompare(b.source_id));
    record.assets.sort((a, b) => a.asset_id.localeCompare(b.asset_id));
    await writeJson(path.join(INVADERS_DIR, `${record.invader_id}.json`), record);
  }

  await writeJson(OUTPUT_PATH, {
    generated_at: new Date().toISOString(),
    total_invaders: records.length,
    source_types: collectSourceTypes(records),
    asset_roles: collectAssetRoles(records),
    invaders: records,
  });

  console.log(`Wrote ${records.length} invader records to ${OUTPUT_PATH}`);
}

async function loadReferenceMetadata(invaders, places) {
  const placeIds = await safeReadDir(REFERENCES_DIR);
  for (const placeId of placeIds) {
    const placeDir = path.join(REFERENCES_DIR, placeId);
    const entries = await safeReadDir(placeDir);
    for (const entry of entries) {
      if (!/^[A-Z0-9]+_\d+$/.test(entry)) continue;
      const metadataPath = path.join(placeDir, entry, 'metadata.json');
      try {
        const metadata = await readJson(metadataPath);
        const record = getOrCreateInvader(invaders, metadata.invader_id, places, metadata.place_id);

        record.place_id ??= metadata.place_id ?? derivePlaceId(metadata.invader_id);
        record.city ??= metadata.city;
        record.country ??= metadata.country;
        record.status ??= metadata.status;
        record.points ??= metadata.points ?? null;
        record.pose_date ??= metadata.pose_date ?? null;
        record.last_known_state ??= metadata.last_known_state ?? null;
        record.notes.push(...toArray(metadata.notes));

        for (const source of metadata.sources ?? []) {
          const sourceId = stableId(
            'source',
            metadata.invader_id,
            source.type ?? 'reference-source',
            source.url ?? source.label ?? JSON.stringify(source),
          );
          upsertSource(record, {
            source_id: sourceId,
            type: source.type ?? 'reference-source',
            label: source.label ?? null,
            url: source.url ?? null,
            file_path: null,
            provenance_confidence: inferSourceConfidence(source.type),
            id_evidence: {
              method: 'curated-metadata',
              detail: metadata.status ?? null,
            },
            extra: compactObject({
              place_id: metadata.place_id ?? null,
            }),
          });
        }

        for (const image of metadata.images ?? []) {
          const sourceId = stableId(
            'source',
            metadata.invader_id,
            image.type ?? 'reference-image',
            image.url ?? image.local_path ?? image.title ?? image.caption ?? JSON.stringify(image),
          );
          upsertSource(record, {
            source_id: sourceId,
            type: image.type ?? 'reference-image',
            label: image.title ?? image.caption ?? null,
            url: image.url ?? null,
            file_path: image.local_path ?? null,
            provenance_confidence: inferSourceConfidence(image.type),
            id_evidence: {
              method: 'curated-metadata',
              detail: image.role ?? null,
            },
            extra: compactObject({
              preview_url: image.preview_url ?? null,
              caption: image.caption ?? null,
            }),
          });

          upsertAsset(record, {
            asset_id: stableId(
              'asset',
              metadata.invader_id,
              image.role ?? image.type ?? 'asset',
              image.local_path ?? image.url ?? image.title ?? image.caption ?? JSON.stringify(image),
            ),
            source_id: sourceId,
            role: image.role ?? 'reference',
            contains_invader: image.contains_invader ?? true,
            local_path: image.local_path ?? null,
            url: image.url ?? null,
            preview_url: image.preview_url ?? null,
            title: image.title ?? null,
            caption: image.caption ?? null,
            derived_from: 'reference-metadata',
            crop: null,
          });
        }
      } catch {
        continue;
      }
    }
  }
}

async function loadFlashScreenshotMetadata(invaders, places) {
  let flashIndex;
  try {
    flashIndex = await readJson(FLASH_INDEX_PATH);
  } catch {
    return;
  }

  const flashInputDir = flashIndex.inputDir ?? null;

  for (const entry of flashIndex.records ?? []) {
    const placeId = derivePlaceId(entry.invaderId);
    const record = getOrCreateInvader(invaders, entry.invaderId, places, placeId);
    const sourceId = stableId('source', entry.invaderId, 'flash-invaders-screenshot', entry.sourcePath);

    upsertSource(record, {
      source_id: sourceId,
      type: 'flash-invaders-screenshot',
      label: path.basename(entry.sourcePath),
      url: null,
      file_path: relativizeExternal(entry.sourcePath, flashInputDir),
      provenance_confidence: entry.ocrConfidence >= 0.95 ? 'high' : 'medium',
      id_evidence: {
        method: 'ocr',
        detail: entry.ocrLine ?? null,
        confidence: entry.ocrConfidence ?? null,
      },
      extra: compactObject({
        all_ocr_lines: entry.allOcrLines ?? [],
      }),
    });

    upsertAsset(record, {
      asset_id: stableId('asset', entry.invaderId, 'screenshot-crop', entry.cropPath),
      source_id: sourceId,
      role: 'screenshot-crop',
      contains_invader: true,
      local_path: relativize(entry.cropPath),
      url: null,
      preview_url: null,
      title: path.basename(entry.cropPath),
      caption: null,
      derived_from: 'flash-screenshot',
      crop: entry.cropRect
        ? {
            x: entry.cropRect.x,
            y: entry.cropRect.y,
            width: entry.cropRect.width,
            height: entry.cropRect.height,
          }
        : null,
    });
  }
}

function getOrCreateInvader(map, invaderId, places, placeId) {
  const existing = map.get(invaderId);
  if (existing) {
    return existing;
  }

  const inferredPlaceId = placeId ?? derivePlaceId(invaderId);
  const place = places[inferredPlaceId] ?? null;
  const record = {
    invader_id: invaderId,
    place_id: inferredPlaceId,
    city: place?.city ?? null,
    country: place?.country ?? null,
    target_count: place?.target_count ?? null,
    status: null,
    points: null,
    pose_date: null,
    last_known_state: null,
    notes: [],
    sources: [],
    assets: [],
    summary: null,
  };
  map.set(invaderId, record);
  return record;
}

function upsertSource(record, source) {
  const existing = record.sources.find((item) => item.source_id === source.source_id);
  if (existing) {
    Object.assign(existing, compactObject({ ...existing, ...source }));
    return;
  }
  record.sources.push(compactObject(source));
}

function upsertAsset(record, asset) {
  const existing = record.assets.find((item) => item.asset_id === asset.asset_id);
  if (existing) {
    Object.assign(existing, compactObject({ ...existing, ...asset }));
    return;
  }
  record.assets.push(compactObject(asset));
}

function buildSummary(record) {
  return {
    source_count: record.sources.length,
    asset_count: record.assets.length,
    source_types: Array.from(new Set(record.sources.map((item) => item.type))).sort(),
    asset_roles: Array.from(new Set(record.assets.map((item) => item.role))).sort(),
    has_positive_reference: record.assets.some((item) => item.contains_invader === true),
    has_negative_reference: record.assets.some((item) => item.contains_invader === false),
  };
}

function collectSourceTypes(records) {
  return Array.from(new Set(records.flatMap((record) => record.sources.map((source) => source.type)))).sort();
}

function collectAssetRoles(records) {
  return Array.from(new Set(records.flatMap((record) => record.assets.map((asset) => asset.role)))).sort();
}

function inferSourceConfidence(type) {
  switch (type) {
    case 'official':
    case 'invader-spotter-grosplan':
    case 'invader-spotter-photo':
    case 'flash-invaders-screenshot':
      return 'high';
    case 'flickr':
    case 'instagram-tag':
      return 'medium';
    default:
      return 'medium';
  }
}

function derivePlaceId(invaderId) {
  return String(invaderId).split('_', 1)[0];
}

function stableId(...parts) {
  return parts
    .join(':')
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '-')
    .replace(/-+/g, '-');
}

function relativize(targetPath) {
  if (!targetPath) return null;
  if (targetPath.startsWith(ROOT)) {
    return path.relative(ROOT, targetPath);
  }
  return targetPath;
}

function relativizeExternal(targetPath, baseDir) {
  if (!targetPath) return null;
  if (baseDir && targetPath.startsWith(baseDir)) {
    return path.join('external-source', path.relative(baseDir, targetPath));
  }
  return path.basename(targetPath);
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined && entry !== ''));
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value];
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
