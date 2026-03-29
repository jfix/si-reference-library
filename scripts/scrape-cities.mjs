import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = '/Users/jakob/Projects/si-reference-library';
const OUTPUT_PATH = path.join(ROOT, 'data', 'cities.json');
const SOURCE_URL = 'https://www.invader-spotter.art/villes.php';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(SOURCE_URL, { waitUntil: 'networkidle' });

    const cities = await page.evaluate((sourceUrl) => {
      const normalize = (value) => value.replace(/\s+/g, ' ').trim();
      const findImmediateCount = (anchor) => {
        let node = anchor.nextSibling;
        let text = '';

        while (node) {
          if (node.nodeType === Node.TEXT_NODE) {
            text += ` ${node.textContent ?? ''}`;
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            const element = /** @type {Element} */ (node);

            if (element.matches('a[href^="javascript:envoi("]')) {
              break;
            }

            text += ` ${element.textContent ?? ''}`;
          }

          const match = text.match(/\((\d+)\s*\/\s*(\d+)\)/);
          if (match) {
            return match;
          }

          node = node.nextSibling;
        }

        return null;
      };

      return Array.from(document.querySelectorAll('a[href]'))
        .map((anchor) => {
          const href = anchor.getAttribute('href') ?? '';
          const text = normalize(anchor.textContent ?? '');

          const match = href.match(/^javascript:envoi\("([A-Z0-9_]+)"\)$/i);
          if (!match || !text) {
            return null;
          }

          const countMatch = findImmediateCount(anchor);
          if (!countMatch) {
            return null;
          }

          return {
            code: match[1],
            city: text,
            foundCount: Number.parseInt(countMatch[1], 10),
            totalCount: Number.parseInt(countMatch[2], 10),
            source: sourceUrl,
          };
        })
        .filter(Boolean);
    }, SOURCE_URL);

    const unique = dedupeCities(cities);

    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await fs.writeFile(
      OUTPUT_PATH,
      JSON.stringify(
        {
          source: SOURCE_URL,
          scrapedAt: new Date().toISOString(),
          totalCities: unique.length,
          cities: unique,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );

    console.log(`Wrote ${unique.length} city entries to ${OUTPUT_PATH}`);
  } finally {
    await page.close();
    await browser.close();
  }
}

function dedupeCities(entries) {
  const seen = new Map();

  for (const entry of entries) {
    if (!entry?.city || !entry?.code) {
      continue;
    }

    const key = `${entry.code}::${entry.city}`;
    if (!seen.has(key)) {
      seen.set(key, entry);
    }
  }

  return Array.from(seen.values()).sort((a, b) => a.city.localeCompare(b.city));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
