import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SOURCE_URL = 'https://www.invader-spotter.art/news.php';
const DEFAULT_OUTPUT_PATH = path.join(ROOT, 'tmp', 'news-discovery-report.json');
const FETCH_TIMEOUT_MS = 60_000;
const FETCH_RETRIES = 3;

const options = parseArgs(process.argv.slice(2));

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  const html = await fetchTextWithRetries(SOURCE_URL, {
    retries: FETCH_RETRIES,
    timeoutMs: FETCH_TIMEOUT_MS,
  });

  const rawEvents = parseNewsEvents(html);

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

function parseNewsEvents(html) {
  const monthSectionPattern = /<div\s+id='mois(\d{4})(\d{2})'>([\s\S]*?)<\/div>/gi;
  const paragraphPattern = /<p\s+class='news'>([\s\S]*?)<\/p>/gi;
  const linkPattern = /<a\s+[^>]*href='javascript:lienm\([^']+\);'[^>]*>([^<]+)<\/a>/gi;

  const events = [];
  let monthMatch;

  while ((monthMatch = monthSectionPattern.exec(html)) !== null) {
    const year = Number.parseInt(monthMatch[1], 10);
    const month = Number.parseInt(monthMatch[2], 10);
    const sectionHtml = monthMatch[3] ?? '';
    let currentDay = null;
    let paragraphMatch;

    paragraphPattern.lastIndex = 0;
    while ((paragraphMatch = paragraphPattern.exec(sectionHtml)) !== null) {
      const paragraphHtml = paragraphMatch[1] ?? '';
      const paragraphText = normalizeWhitespace(stripTags(decodeHtml(paragraphHtml)));
      const dayMatch = paragraphText.match(/^(\d{1,2})\s*:/);
      if (dayMatch) {
        currentDay = Number.parseInt(dayMatch[1], 10);
      }

      if (!currentDay) {
        continue;
      }

      let linkMatch;
      linkPattern.lastIndex = 0;
      while ((linkMatch = linkPattern.exec(paragraphHtml)) !== null) {
        const fullAnchor = linkMatch[0] ?? '';
        const idText = normalizeWhitespace(decodeHtml(linkMatch[1] ?? '')).toUpperCase();
        if (!/^[A-Z0-9]+_\d+$/.test(idText)) {
          continue;
        }

        const classMatch = fullAnchor.match(/class='([^']*)'/i);
        const className = normalizeWhitespace(classMatch?.[1] ?? '');

        events.push({
          invader_id: idText,
          year,
          month,
          day: currentDay,
          class_name: className,
          paragraph_text: paragraphText,
        });
      }
    }
  }

  return events;
}

async function fetchTextWithRetries(url, options = {}) {
  const retries = options?.retries ?? 3;
  const timeoutMs = options?.timeoutMs ?? 60_000;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.text();
    } catch (error) {
      const lastAttempt = attempt === retries;
      const message = error instanceof Error ? error.message : String(error);
      if (lastAttempt) {
        throw error;
      }

      console.warn(`[warn] news fetch attempt ${attempt}/${retries} failed: ${message}`);
      await sleep(1000 * attempt);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function stripTags(value) {
  return String(value).replace(/<[^>]*>/g, ' ');
}

function normalizeWhitespace(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function decodeHtml(value) {
  const named = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&lt;': '<',
    '&gt;': '>',
    '&eacute;': 'e',
    '&egrave;': 'e',
    '&ecirc;': 'e',
    '&agrave;': 'a',
    '&acirc;': 'a',
    '&uuml;': 'u',
    '&ucirc;': 'u',
    '&ocirc;': 'o',
    '&iuml;': 'i',
    '&ccedil;': 'c',
  };

  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&#x([\da-fA-F]+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&[a-zA-Z#0-9]+;/g, (entity) => named[entity] ?? entity);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
