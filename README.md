# `si-reference-library`

Reference image library for Space Invader mosaics where we know the official identifier, such as `AIX_05` or `AVI_13`.

## Goal

Store:

- several reference images per invader from different angles
- stable metadata for each invader
- provenance for each image and identifier match

## Proposed layout

```text
references/
  AIX/
    AIX_01/
      metadata.json
      sources/
      images/
    AIX_02/
  AVI/
metadata/
  places.json
```

## Metadata shape

Each invader directory should contain a `metadata.json` file with:

```json
{
  "place_id": "AIX",
  "invader_id": "AIX_01",
  "city": "Aix-en-Provence",
  "country": "France",
  "status": "confirmed",
  "sources": [],
  "images": []
}
```

## Notes

- Prefer primary or near-primary sources first:
  - official Space Invader pages
  - Spotter Invader
  - Instagram posts with explicit identifier confirmation
- Keep source attribution for every image.
- Do not rename downloaded originals destructively; store the original file and record normalized metadata separately.

## Scraping

First pass for the spotter site city index:

```bash
npm run scrape:cities
```

This writes:

- `data/cities.json`

Per-city listing scrape:

```bash
npm run scrape:city -- AIX
```

This writes:

- `data/cities/AIX.json`

To also sync the scraped invaders into `references/<CITY>/...`:

```bash
npm run scrape:city -- AIX --sync-references
```

To additionally download the referenced spotter images into each invader directory:

```bash
npm run scrape:city -- AIX --sync-references --download-images
```

## Instagram Session Probe

Instagram tag pages currently redirect anonymous requests to login. To test a saved logged-in browser profile:

1. Open a persistent Playwright browser and log in manually:

```bash
npm run instagram:login -- https://www.instagram.com/explore/tags/aix_06/
```

2. After login, press Enter in the terminal to save the profile.

3. Reuse that saved session in headless mode to probe a tag page:

```bash
npm run instagram:test -- https://www.instagram.com/explore/tags/aix_06/
```

The browser profile is stored under `profiles/instagram/` and is ignored by git.

To scrape post links and media for a tag using the saved session:

```bash
npm run instagram:scrape -- aix_06 --limit=12 --download
```

This writes results under `data/instagram/<tag>/`.

## Audit

Run a reference-library audit to measure:

- city coverage against the scraped city list
- live-feed overlap against `collect-si-live-data`
- per-invader metadata and asset quality issues

```bash
npm run audit:library
```

This writes:

- `data/audits/reference-library-audit.json`
