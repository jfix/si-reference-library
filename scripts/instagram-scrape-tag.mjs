import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = '/Users/jakob/Projects/si-reference-library';
const PROFILE_DIR = path.join(ROOT, 'profiles', 'instagram');
const OUTPUT_DIR = path.join(ROOT, 'data', 'instagram');
const BASE_URL = 'https://www.instagram.com';

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1440, height: 960 },
  });

  try {
    const tagPage = context.pages()[0] ?? (await context.newPage());
    const tagUrl = `${BASE_URL}/explore/tags/${encodeURIComponent(options.tag)}/`;

    await tagPage.goto(tagUrl, { waitUntil: 'domcontentloaded' });
    await tagPage.waitForTimeout(2500);

    const posts = await collectPostLinks(tagPage, options.limitPosts);
    const enriched = [];

    for (const postPath of posts) {
      const page = await context.newPage();

      try {
        await page.goto(new URL(postPath, BASE_URL).href, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
        const post = await extractPost(page);
        if (!post) {
          continue;
        }

        if (options.download) {
          const mediaDir = path.join(OUTPUT_DIR, sanitizeTag(options.tag), 'media', sanitizePathSegment(post.shortcode));
          await fs.mkdir(mediaDir, { recursive: true });

          for (let index = 0; index < post.media.length; index += 1) {
            const media = post.media[index];
            const extension = inferExtension(media.url, media.type);
            const destination = path.join(mediaDir, `${String(index + 1).padStart(2, '0')}${extension}`);
            await downloadFile(media.url, destination);
            media.local_path = path.relative(ROOT, destination);
          }
        }

        enriched.push(post);
      } finally {
        await page.close();
      }
    }

    const output = {
      tag: options.tag,
      source: tagUrl,
      scrapedAt: new Date().toISOString(),
      totalPosts: enriched.length,
      posts: enriched,
    };

    const outputDir = path.join(OUTPUT_DIR, sanitizeTag(options.tag));
    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'posts.json');
    await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

    console.log(`Wrote ${enriched.length} Instagram posts to ${outputPath}`);
  } finally {
    await context.close();
  }
}

function parseArgs(args) {
  const options = {
    tag: null,
    limitPosts: 12,
    download: false,
  };

  for (const arg of args) {
    if (!options.tag && !arg.startsWith('--')) {
      options.tag = arg.replace(/^#/, '');
      continue;
    }

    if (arg === '--download') {
      options.download = true;
      continue;
    }

    if (arg.startsWith('--limit=')) {
      options.limitPosts = Number.parseInt(arg.slice('--limit='.length), 10);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.tag) {
    throw new Error('Usage: npm run instagram:scrape -- <tag> [--limit=12] [--download]');
  }

  return options;
}

async function collectPostLinks(page, limit) {
  const seen = new Set();

  for (let attempt = 0; attempt < 6 && seen.size < limit; attempt += 1) {
    const paths = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .map((anchor) => anchor.getAttribute('href'))
        .filter((href) => typeof href === 'string' && /^\/p\/[^/]+\/?$/.test(href)),
    );

    for (const path of paths) {
      seen.add(path);
      if (seen.size >= limit) {
        break;
      }
    }

    if (seen.size >= limit) {
      break;
    }

    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(2000);
  }

  return Array.from(seen).slice(0, limit);
}

async function extractPost(page) {
  return page.evaluate(() => {
    const normalize = (value) => value.replace(/\s+/g, ' ').trim();
    const pathnameParts = location.pathname.split('/').filter(Boolean);
    const shortcode = pathnameParts[1] ?? null;
    if (!shortcode) {
      return null;
    }

    const article = document.querySelector('article');
    const text = article ? normalize(article.innerText) : normalize(document.body.innerText);
    const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? null;
    const media = ogImage
      ? [
          {
            type: 'image',
            role: 'primary',
            url: ogImage,
          },
        ]
      : [];

    return {
      shortcode,
      url: location.href,
      text: text.slice(0, 5000),
      media,
    };
  });
}

async function downloadFile(url, destinationPath) {
  try {
    await fs.access(destinationPath);
    return;
  } catch {
    // not present yet
  }

  const response = await fetch(url, {
    headers: {
      Referer: BASE_URL,
      'User-Agent': 'si-reference-library/0.1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destinationPath, buffer);
}

function sanitizeTag(tag) {
  return tag.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}

function sanitizePathSegment(value) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-');
}

function inferExtension(url, type) {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith('.png')) return '.png';
  if (pathname.endsWith('.webp')) return '.webp';
  if (pathname.endsWith('.heic')) return '.heic';
  if (type === 'video') return '.mp4';
  return '.jpg';
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
