import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = '/Users/jakob/Projects/si-reference-library';
const REFERENCES_DIR = path.join(ROOT, 'references');
const LISTING_URL = 'https://www.invader-spotter.art/listing.php';

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cityDir = path.join(REFERENCES_DIR, options.code);
  const invaderIds = (await safeReadDir(cityDir))
    .filter((entry) => new RegExp(`^${options.code}_\\d+$`).test(entry))
    .sort((a, b) => numericSuffix(a) - numericSuffix(b));

  if (invaderIds.length === 0) {
    throw new Error(`No invader directories found for ${options.code}`);
  }

  const startIndex = options.startIndex ?? 1;
  const endIndex = Math.min(options.endIndex ?? invaderIds.length, invaderIds.length);
  const selected = invaderIds.slice(startIndex - 1, endIndex);

  let metadataFilesUpdated = 0;
  let filesDownloaded = 0;
  let filesAlreadyPresent = 0;

  for (const [position, invaderId] of selected.entries()) {
    console.log(`Downloading ${options.code} images ${startIndex + position}/${endIndex}: ${invaderId}`);
    const metadataPath = path.join(cityDir, invaderId, 'metadata.json');
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    const imagesDir = path.join(cityDir, invaderId, 'images');
    await fs.mkdir(imagesDir, { recursive: true });

    let changed = false;
    for (const image of metadata.images ?? []) {
      const imageUrl = image.url ?? null;
      if (!imageUrl) continue;

      const filename = path.basename(new URL(imageUrl).pathname);
      const localPath = path.join(imagesDir, filename);
      const relativeLocalPath = path.relative(ROOT, localPath);

      if (await pathExists(localPath)) {
        filesAlreadyPresent += 1;
        if (image.local_path !== relativeLocalPath) {
          image.local_path = relativeLocalPath;
          changed = true;
        }
        continue;
      }

      await downloadFile(imageUrl, localPath);
      image.local_path = relativeLocalPath;
      filesDownloaded += 1;
      changed = true;
    }

    if (changed) {
      await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
      metadataFilesUpdated += 1;
    }
  }

  console.log(JSON.stringify({
    code: options.code,
    start_index: startIndex,
    end_index: endIndex,
    invaders_processed: selected.length,
    metadata_files_updated: metadataFilesUpdated,
    files_downloaded: filesDownloaded,
    files_already_present: filesAlreadyPresent,
  }, null, 2));
}

function parseArgs(args) {
  const options = {
    code: null,
    startIndex: null,
    endIndex: null,
  };

  for (const arg of args) {
    if (!options.code && !arg.startsWith('--')) {
      options.code = arg.toUpperCase();
      continue;
    }

    if (arg.startsWith('--start-index=')) {
      options.startIndex = parsePositiveInteger(arg.split('=')[1], '--start-index');
      continue;
    }

    if (arg.startsWith('--end-index=')) {
      options.endIndex = parsePositiveInteger(arg.split('=')[1], '--end-index');
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.code) {
    throw new Error('Usage: npm run download:city-images -- <CITY_CODE> [--start-index=N] [--end-index=N]');
  }

  if (options.startIndex && options.endIndex && options.endIndex < options.startIndex) {
    throw new Error('--end-index must be greater than or equal to --start-index');
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

function numericSuffix(invaderId) {
  return Number.parseInt(invaderId.split('_').at(-1), 10);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function safeReadDir(dirPath) {
  try {
    return await fs.readdir(dirPath);
  } catch {
    return [];
  }
}

async function downloadFile(url, destinationPath) {
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
