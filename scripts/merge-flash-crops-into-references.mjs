import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = '/Users/jakob/Projects/si-reference-library';
const REFERENCES_DIR = path.join(ROOT, 'references');
const FLASH_INDEX_PATH = path.join(ROOT, 'data', 'flash-screenshots', 'index.json');

async function main() {
  const flashIndex = await readJson(FLASH_INDEX_PATH);
  const recordsByInvader = groupByInvader(flashIndex.records ?? []);
  const placeIds = await safeReadDir(REFERENCES_DIR);
  let metadataUpdated = 0;
  let imagesAdded = 0;
  const updatedInvaders = [];

  for (const placeId of placeIds) {
    const placeDir = path.join(REFERENCES_DIR, placeId);
    const invaderIds = (await safeReadDir(placeDir)).filter((entry) => /^[A-Z0-9]+_\d+$/.test(entry));
    for (const invaderId of invaderIds) {
      const records = recordsByInvader.get(invaderId) ?? [];
      if (records.length === 0) continue;

      const metadataPath = path.join(placeDir, invaderId, 'metadata.json');
      const metadata = await readJson(metadataPath).catch(() => null);
      if (!metadata) continue;

      const images = Array.isArray(metadata.images) ? metadata.images : [];
      const sources = Array.isArray(metadata.sources) ? metadata.sources : [];
      let changed = false;
      let addedForInvader = 0;

      for (const record of records) {
        const relativeCropPath = relativize(record.cropPath);
        const relativeSourcePath = relativizeExternal(record.sourcePath, flashIndex.inputDir ?? null);
        const sourceLabel = `Flash screenshot for ${invaderId}`;
        const sourceExists = sources.some(
          (source) =>
            source?.type === 'flash-invaders-screenshot' &&
            source?.label === sourceLabel &&
            source?.file_path === relativeSourcePath,
        );

        if (!sourceExists) {
          sources.push({
            type: 'flash-invaders-screenshot',
            label: sourceLabel,
            file_path: relativeSourcePath,
          });
          changed = true;
        }

        const imageExists = images.some(
          (image) => image?.role === 'flash-reference' && image?.local_path === relativeCropPath,
        );
        if (imageExists) continue;

        images.push({
          type: 'flash-invaders-screenshot',
          role: 'flash-reference',
          contains_invader: true,
          local_path: relativeCropPath,
          title: path.basename(record.cropPath),
        });
        changed = true;
        addedForInvader += 1;
      }

      if (!changed) continue;

      metadata.sources = sources;
      metadata.images = images;
      await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
      metadataUpdated += 1;
      imagesAdded += addedForInvader;
      updatedInvaders.push({ invaderId, added_images: addedForInvader });
    }
  }

  console.log(
    JSON.stringify(
      {
        metadata_updated: metadataUpdated,
        images_added: imagesAdded,
        updated_invaders: updatedInvaders,
      },
      null,
      2,
    ),
  );
}

function groupByInvader(records) {
  const grouped = new Map();
  for (const record of records) {
    if (!record?.invaderId || !record?.cropPath) continue;
    const bucket = grouped.get(record.invaderId) ?? [];
    bucket.push(record);
    grouped.set(record.invaderId, bucket);
  }
  return grouped;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function safeReadDir(dirPath) {
  try {
    return await fs.readdir(dirPath);
  } catch {
    return [];
  }
}

function relativize(absolutePath) {
  return path.relative(ROOT, absolutePath).split(path.sep).join('/');
}

function relativizeExternal(absolutePath, inputDir) {
  if (inputDir) {
    const relative = path.relative(inputDir, absolutePath);
    if (!relative.startsWith('..')) {
      return relative.split(path.sep).join('/');
    }
  }
  return absolutePath;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
