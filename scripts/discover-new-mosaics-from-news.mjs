import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SOURCE_URL = 'https://www.invader-spotter.art/news.php';
const DEFAULT_OUTPUT_PATH = path.join(ROOT, 'tmp', 'news-discovery-report.json');
const NAVIGATION_TIMEOUT_MS = 60_000;
const NAVIGATION_RETRIES = 3;

const options = parseArgs(process.argv.slice(2));

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

  try {
    await gotoWithRetries(page, SOURCE_URL, {
      retries: NAVIGATION_RETRIES,
      timeoutMs: NAVIGATION_TIMEOUT_MS,
    });

    const rawEvents = await page.evaluate(() => {
      const monthSections = Array.from(document.querySelectorAll('div[id^="mois"]'));
      const events = [];

      const normalizeSpace = (value) => value.replace(/\s+/g, ' ').trim();

      for (const monthSection of monthSections) {
        const id = monthSection.id ?? '';
        const match = id.match(/^mois(\d{4})(\d{2})$/);
        if (!match) {
          continue;
        }

        const year = Number.parseInt(match[1], 10);
        const month = Number.parseInt(match[2], 10);
        let currentDay = null;

        for (const paragraph of monthSection.querySelectorAll('p.news')) {
          const text = normalizeSpace(paragraph.textContent ?? '');
          const dayMatch = text.match(/^(\d{1,2})\s*:/);
          if (dayMatch) {
            currentDay = Number.parseInt(dayMatch[1], 10);
          }

          if (!currentDay) {
            continue;
          }

          for (const anchor of paragraph.querySelectorAll('a[href^="javascript:lienm("]')) {
            const invaderId = normalizeSpace(anchor.textContent ?? '').toUpperCase();
            if (!/^[A-Z0-9]+_\d+$/.test(invaderId)) {
              continue;
            }

            events.push({
              invader_id: invaderId,
              year,
              month,
              day: currentDay,
              class_name: normalizeSpace(anchor.className || ''),
              paragraph_text: text,
            });
          }
        }
      }

      return events;
    });

    const cutoffEpochMs = Date.now() - (options.maxDays * 24 * 60 * 60 * 1000);
    const recentEvents = rawEvents
      .map((entry) => {
        const dateIso = toIsoDate(entry.year, entry.month, entry.day);
        const timestamp = Date.parse(`${dateIso}T00:00:00Z`);
        return {
          ...entry,
          date_iso: dateIso,
          timestamp,
        };
      })
      .filter((entry) => Number.isFinite(entry.timestamp) && entry.timestamp >= cutoffEpochMs);

    const candidateInvaders = dedupeByInvader(
      recentEvents
        .filter((entry) => isGreenSignal(entry.class_name, entry.paragraph_text))
        .map((entry) => ({
          invader_id: entry.invader_id,
          code: deriveCode(entry.invader_id),
          date_iso: entry.date_iso,
          class_name: entry.class_name,
          signal: 'green',
          paragraph_text: entry.paragraph_text,
        })),
    );

    const report = {
      generated_at: new Date().toISOString(),
      source: SOURCE_URL,
      max_days: options.maxDays,
      recent_event_count: recentEvents.length,
      candidate_invader_count: candidateInvaders.length,
      candidate_invaders: candidateInvaders,
    };

    await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
    await fs.writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log(JSON.stringify({
      report: options.outputPath,
      max_days: options.maxDays,
      recent_event_count: report.recent_event_count,
      candidate_invader_count: report.candidate_invader_count,
      candidate_invaders: report.candidate_invaders.map((entry) => entry.invader_id),
    }, null, 2));
  } finally {
    await page.close();
    await browser.close();
  }
}

function parseArgs(args) {
  const options = {
    outputPath: DEFAULT_OUTPUT_PATH,
    maxDays: 10,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg.startsWith('--output-path=')) {
      options.outputPath = path.resolve(process.cwd(), arg.split('=')[1]);
      continue;
    }

    if (arg === '--output-path') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--output-path requires a value');
      }
      options.outputPath = path.resolve(process.cwd(), value);
      index += 1;
      continue;
    }

    if (arg.startsWith('--max-days=')) {
      options.maxDays = parsePositiveInteger(arg.split('=')[1], '--max-days');
      continue;
    }

    if (arg === '--max-days') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--max-days requires a value');
      }
      options.maxDays = parsePositiveInteger(value, '--max-days');
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
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

function isGreenSignal(className, paragraphText) {
  const text = normalizeParagraphText(paragraphText);
  const likelyPositive = /\bajout|nouveau|nouveaux|nouvelle|nouvelles|pose|poses|added|new\b/.test(text);
  const likelyNegative = /\bdestruction|degradation|reactivation|restauration|mise a jour|statut|alerte\b/.test(text);

  const classTokens = String(className)
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

  if (classTokens.includes('ok') && !likelyNegative) {
    return true;
  }

  return likelyPositive;
}

function normalizeParagraphText(value) {
  return String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

function dedupeByInvader(entries) {
  const byInvader = new Map();

  for (const entry of entries) {
    const existing = byInvader.get(entry.invader_id);
    if (!existing) {
      byInvader.set(entry.invader_id, entry);
      continue;
    }

    if (entry.date_iso > existing.date_iso) {
      byInvader.set(entry.invader_id, entry);
    }
  }

  return Array.from(byInvader.values()).sort((left, right) => right.date_iso.localeCompare(left.date_iso) || left.invader_id.localeCompare(right.invader_id));
}

function deriveCode(invaderId) {
  return String(invaderId).split('_', 1)[0];
}

function toIsoDate(year, month, day) {
  const yyyy = String(year).padStart(4, '0');
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function gotoWithRetries(page, url, options) {
  const retries = options?.retries ?? 3;
  const timeoutMs = options?.timeoutMs ?? 60_000;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      return;
    } catch (error) {
      const lastAttempt = attempt === retries;
      const message = error instanceof Error ? error.message : String(error);
      if (lastAttempt) {
        throw error;
      }

      console.warn(`[warn] news navigation attempt ${attempt}/${retries} failed: ${message}`);
      await sleep(1000 * attempt);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
