# Reference Corpus Automation Status

Last updated: 1 Jun 2026

Status legend:

- `done`
- `in_progress`
- `blocked`
- `not_started`

Timestamp format: European-style local time. For `done` rows, `Completed At` should use the best available git commit timestamp for the owning code path; if a change is still only in the local working tree, use the implementation timestamp recorded here until it is committed.

## Current Summary

- Daily discovery workflow now completes end-to-end locally and is being wired to persist changes back to the canonical repo.
- Daily report generation works.
- R2 upload path exists and the manifest upload step is wired.
- Notifications exist.
- Latest successful daily run found `0` new invaders and `0` failed cities.
- Cross-repo image-wall auth in GitHub Actions is now stable.
- Workflow now fails fast when Cloudflare credentials are missing.
- Upload step now enforces failure detection from upload logs.
- Workflow now includes a catch-up upload step to reconcile any refs missing from R2.
- Notification handling now tolerates invalid ntfy URLs without crashing the job.
- Missing Paris refs (`PA_1571` to `PA_1590`) were backfilled to R2 and verified live.
- Deployment manifest metadata is now persisted into image-wall D1 and exposed on the model page.
- Daily discovery workflow runs inside the Playwright container image (`mcr.microsoft.com/playwright:v1.58.2-noble`) — Playwright install step removed.
- Upload step now logs wrangler stderr on failure for easier debugging.
- Upload step currently failing with `403 Authentication error` — GitHub secret `CLOUDFLARE_API_TOKEN` is expired/invalid and must be rotated.
- Trainer-side merged corpus refresh is not yet implemented.
- Automated index deployment is not yet implemented.
- Retraining orchestration is not yet implemented.

## Task Board

| Area | Task | Repo | Status | Completed At | Updated At | Notes |
|---|---|---|---|---|---|---|
| Discovery | Daily invader-spotter scheduled job | si-reference-library | `blocked` | — | 1 Jun 2026 | CI regression: upload step failing with 403 after `CLOUDFLARE_API_TOKEN` secret expired. Playwright install issue fixed (container image). Unblock: rotate secret in GitHub repo settings. |
| Discovery | Count-first city gating | si-reference-library | `done` | 3 Apr 2026, 17:02 | 3 Apr 2026, 17:02 | Remote total is checked before a city scrape is attempted |
| Discovery | Delta-tail scraping for contiguous cities | si-reference-library | `done` | 3 Apr 2026, 17:02 | 3 Apr 2026, 17:02 | Pagination now uses the confirmed 50-item page size |
| Discovery | Retry and continue on flaky city failures | si-reference-library | `done` | 3 Apr 2026, 17:02 | 3 Apr 2026, 17:02 | Per-city retries and failure capture exist |
| Discovery | Non-fatal broken photo downloads | si-reference-library | `done` | 3 Apr 2026, 17:02 | 3 Apr 2026, 17:02 | 404 photo URLs no longer abort the whole city scrape |
| Discovery | Daily manifest/report output | si-reference-library | `done` | 3 Apr 2026, 17:02 | 3 Apr 2026, 17:02 | `tmp/daily-new-mosaics-report.json` |
| Discovery | ntfy notification | si-reference-library | `done` | 3 Apr 2026, 17:02 | 3 Apr 2026, 17:02 | Implemented in `scripts/send-ntfy.mjs` |
| Persistence | Durable persistence of newly discovered refs | si-reference-library | `in_progress` | — | 26 May 2026, 00:16 | Commit/push path is wired in CI; needs verification on a run with actual new refs |
| Serving | Upload new ref images to R2 | si-reference-library + si-image-wall | `done` | 25 May 2026, 16:26 | 27 May 2026, 19:05 | CI credentials validation and upload failure detection are enforced; missing refs were backfilled and verified live |
| Serving | Catch-up reconciliation upload for missing refs | si-reference-library + si-image-wall | `done` | 27 May 2026, 19:05 | 27 May 2026, 19:05 | Daily workflow now runs a full `--skip-existing` pass after manifest upload to prevent R2 drift |
| Corpus refresh | Consume reference-library state in trainer pipeline | si-image-trainer-mvp | `not_started` | — | 25 May 2026, 18:16 | Needs automated trainer-side job |
| Corpus refresh | Consume crowd-confirmed flash labels via export endpoint | si-image-trainer-mvp | `not_started` | — | 25 May 2026, 18:16 | Documented, but not yet wired into a running job |
| Corpus refresh | Merge scraped refs and confirmed flash labels | si-image-trainer-mvp | `not_started` | — | 25 May 2026, 18:16 | Core missing piece |
| Indexing | Build refreshed retrieval indexes automatically | si-image-trainer-mvp | `not_started` | — | 25 May 2026, 18:16 | Local building blocks exist |
| Indexing | Atomic index publication | si-image-trainer-mvp | `not_started` | — | 25 May 2026, 18:16 | Planned in docs only |
| Deployment | Reload inference with new indexes | si-image-trainer-mvp | `not_started` | — | 25 May 2026, 18:16 | Modal upload/reload path exists, not automated for this flow |
| Deployment | Persist deployment manifest for model visibility | si-image-wall + si-image-trainer-mvp | `done` | 27 May 2026, 19:05 | 27 May 2026, 19:05 | Trainer upload now POSTs manifest to image-wall `/api/model-meta`; model page reads D1-backed metadata |
| Training | Periodic retraining with evaluation gate | si-image-trainer-mvp | `not_started` | — | 25 May 2026, 18:16 | Should be weekly or threshold-based, not daily |
| Orchestration | Connect discovery workflow to trainer refresh workflow | cross-repo | `not_started` | — | 25 May 2026, 18:16 | Likely `repository_dispatch` or trainer-side scheduled polling |

## Technical Debt

| Task | Repo | Status | Completed At | Updated At | Notes |
|---|---|---|---|---|---|
| Remove Playwright and city-wide scrape fallback from discovery pipeline | si-reference-library | `not_started` | — | 25 May 2026, 20:10 | Keep `news.php` parser as source-of-truth; replace legacy city sweep with targeted enrichment path |

## Current Known Outputs

### From daily discovery

- Successful new local references discovered in the latest run: `0`
- Failed cities in the latest run: `none`
- Previously recovered missing reference: `MLGA_13`

### Latest known report path

- `tmp/daily-new-mosaics-report.json`

## Change Log

### 2026-06-01
- Switched daily workflow to run inside `mcr.microsoft.com/playwright:v1.58.2-noble` container — eliminates the `npx playwright install` timeout that was blocking CI (commits `f4609e25`, `a117165e`).
- Added `defaults: run: shell: bash` to fix `set: Illegal option -o pipefail` error in the Playwright container's default `sh` shell.
- Added wrangler stderr capture to `upload-ref-images.mjs` — failures now log the actual wrangler error instead of a silent FAIL.
- Diagnosed root upload failure: `403 Forbidden / Authentication error (code 10000)` — `CLOUDFLARE_API_TOKEN` GitHub secret is expired. Needs rotation.
- CI runs affected: `26726273214` (canceled during Playwright install), `26726845544` (shell error), `26726935186` (bash fixed, 403 revealed), `26727265420` (stderr added, 403 confirmed).
- Three new PA mosaics (`PA_1591`, `PA_1592`, `PA_1593`) discovered by scraper but not yet uploaded to R2.

## Immediate Next Steps

1. Rotate `CLOUDFLARE_API_TOKEN` GitHub secret (needs Workers R2 Storage: Edit permission) — unblocks the upload step.
2. Verify persistence path on a run that actually produces new refs to commit.
3. Build the trainer-side daily merged corpus refresh job.
4. Add automated index publication and inference reload.
5. Add retraining orchestration with evaluation gates.

## Change Log

### 2026-05-25

- Added daily discovery script and notification helper.
- Added count-first gating based on invader-spotter city totals.
- Added delta-tail scrape planning for contiguous city IDs.
- Updated scraper pagination assumption to 50 items per invader-spotter listing page.
- Added best-effort image download handling for broken spotter photo URLs.
- Added per-city retry and continue behavior in the daily run.
- Added workflow draft for daily discovery + upload + notification.
- Added workflow step to commit and push new reference-library changes.
- Recorded that `PA` and `MLGA` still need fallback hardening.
- Retrieved missing `MLGA_13` image and attached it to the Málaga metadata record.
- Updated the latest daily run to zero new invaders and zero failed cities.

### 2026-05-26

- Stabilized GitHub Actions auth to clone `jfix/si-image-wall`.
- Added Cloudflare secret preflight validation in workflow.
- Added strict upload failure check by parsing upload logs for `FAIL` lines.
- Hardened ntfy sender to skip invalid URLs instead of throwing.
- Replaced non-portable `rg` guard in workflow with `grep` for runner compatibility.
- Confirmed green CI run `26421836404` with credential checks, upload step, and notification step all passing.

### 2026-05-27

- Backfilled missing reference images to R2 and verified Paris refs `PA_1571` through `PA_1590` resolve on Pages.
- Added workflow catch-up upload step (`--skip-existing`) after manifest upload to prevent R2 drift.
- Added D1-backed `model_meta` storage in image-wall and wired trainer upload to publish deployment manifest metadata.
- Updated model page data path to consume persisted manifest metadata via image-wall APIs.

## Update Rule

Whenever a task changes state:

1. Update the task row in this file.
2. Add a short bullet to the change log if the change is meaningful.
3. If the architecture itself changed, also update `docs/ref-corpus-automation-plan.md`.
