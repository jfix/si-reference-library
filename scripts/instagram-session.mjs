import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = '/Users/jakob/Projects/si-reference-library';
const PROFILE_DIR = path.join(ROOT, 'profiles', 'instagram');
const DEFAULT_TAG_URL = 'https://www.instagram.com/explore/tags/aix_06/';

async function main() {
  const [mode = 'test', url = DEFAULT_TAG_URL] = process.argv.slice(2);

  if (mode === 'login') {
    await runLoginFlow(url);
    return;
  }

  if (mode === 'test') {
    await runTestFlow(url);
    return;
  }

  throw new Error('Usage: npm run instagram:login -- [url] | npm run instagram:test -- [url]');
}

async function runLoginFlow(url) {
  await fs.mkdir(PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1440, height: 960 },
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  console.log(`Opened ${url}`);
  console.log('Log in to Instagram in the opened browser window.');
  console.log('After login completes and the page is usable, press Enter here to save the session and exit.');

  await waitForEnter();
  await context.close();
}

async function runTestFlow(url) {
  await fs.mkdir(PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1440, height: 960 },
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const result = await page.evaluate(() => {
    const normalize = (value) => value.replace(/\s+/g, ' ').trim();
    const links = Array.from(document.querySelectorAll('a[href]'))
      .map((anchor) => anchor.getAttribute('href'))
      .filter(Boolean);

    const postLinks = links
      .filter((href) => href.startsWith('/p/') || href.startsWith('https://www.instagram.com/p/'))
      .slice(0, 20);

    const imageLinks = Array.from(document.querySelectorAll('img[src]'))
      .map((img) => img.getAttribute('src'))
      .filter(Boolean)
      .slice(0, 20);

    return {
      location: location.href,
      title: document.title,
      postLinks,
      imageLinks,
      text: normalize(document.body.innerText).slice(0, 1200),
    };
  });

  console.log(JSON.stringify(result, null, 2));
  await context.close();
}

function waitForEnter() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', () => resolve());
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
