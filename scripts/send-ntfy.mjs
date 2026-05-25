import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_REPORT_PATH = path.join(ROOT, 'tmp', 'daily-new-mosaics-report.json');

const options = parseArgs(process.argv.slice(2));

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  const report = await readJson(options.reportPath);
  const newInvaders = Array.isArray(report.new_invaders) ? report.new_invaders : [];

  if (newInvaders.length === 0) {
    console.log('No new mosaics found; skipping ntfy notification.');
    return;
  }

  if (!options.ntfyUrl) {
    console.log('NTFY_URL not set; skipping ntfy notification.');
    return;
  }

  const bodyLines = [
    `Found ${newInvaders.length} new mosaic${newInvaders.length === 1 ? '' : 's'} on invader-spotter.art.`,
    '',
    ...newInvaders.map((entry) => `${entry.invader_id} - ${entry.city ?? entry.code}`),
  ];

  const response = await fetch(options.ntfyUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      Title: 'New Invader mosaics',
      Priority: '4',
      ...(options.ntfyToken ? { Authorization: `Bearer ${options.ntfyToken}` } : {}),
    },
    body: bodyLines.join('\n'),
  });

  if (!response.ok) {
    throw new Error(`ntfy request failed: ${response.status} ${response.statusText}`);
  }

  console.log(`Sent ntfy notification for ${newInvaders.length} new mosaics.`);
}

function parseArgs(args) {
  const options = {
    reportPath: DEFAULT_REPORT_PATH,
    ntfyUrl: process.env.NTFY_URL ?? null,
    ntfyToken: process.env.NTFY_TOKEN ?? null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
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

    if (arg.startsWith('--ntfy-url=')) {
      options.ntfyUrl = arg.split('=')[1] || null;
      continue;
    }

    if (arg === '--ntfy-url') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--ntfy-url requires a value');
      }
      options.ntfyUrl = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--ntfy-token=')) {
      options.ntfyToken = arg.split('=')[1] || null;
      continue;
    }

    if (arg === '--ntfy-token') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--ntfy-token requires a value');
      }
      options.ntfyToken = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}