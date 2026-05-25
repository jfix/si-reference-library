# Reference Corpus Automation Status

Last updated: 25 May 2026, 18:16

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
- Trainer-side merged corpus refresh is not yet implemented.
- Automated index deployment is not yet implemented.
- Retraining orchestration is not yet implemented.

## Task Board

| Area | Task | Repo | Status | Completed At | Updated At | Notes |
|---|---|---|---|---|---|---|
| Discovery | Daily invader-spotter scheduled job | si-reference-library | `in_progress` | — | 25 May 2026, 18:16 | GitHub Action drafted; still needs durable persistence strategy |
| Discovery | Count-first city gating | si-reference-library | `done` | 3 Apr 2026, 17:02 | 3 Apr 2026, 17:02 | Remote total is checked before a city scrape is attempted |
| Discovery | Delta-tail scraping for contiguous cities | si-reference-library | `done` | 3 Apr 2026, 17:02 | 3 Apr 2026, 17:02 | Pagination now uses the confirmed 50-item page size |
| Discovery | Retry and continue on flaky city failures | si-reference-library | `done` | 3 Apr 2026, 17:02 | 3 Apr 2026, 17:02 | Per-city retries and failure capture exist |
| Discovery | Non-fatal broken photo downloads | si-reference-library | `done` | 3 Apr 2026, 17:02 | 3 Apr 2026, 17:02 | 404 photo URLs no longer abort the whole city scrape |
| Discovery | Daily manifest/report output | si-reference-library | `done` | 3 Apr 2026, 17:02 | 3 Apr 2026, 17:02 | `tmp/daily-new-mosaics-report.json` |
| Discovery | ntfy notification | si-reference-library | `done` | 3 Apr 2026, 17:02 | 3 Apr 2026, 17:02 | Implemented in `scripts/send-ntfy.mjs` |
| Persistence | Durable persistence of newly discovered refs | si-reference-library | `in_progress` | — | 25 May 2026, 18:16 | Canonical repo chosen; workflow will commit and push `references/...` plus `data/cities.json` |
| Serving | Upload new ref images to R2 | si-reference-library + si-image-wall | `done` | 25 May 2026, 16:26 | 25 May 2026, 16:26 | Upload script exists and manifest upload path is working locally |
| Corpus refresh | Consume reference-library state in trainer pipeline | si-image-trainer-mvp | `not_started` | — | 25 May 2026, 18:16 | Needs automated trainer-side job |
| Corpus refresh | Consume crowd-confirmed flash labels via export endpoint | si-image-trainer-mvp | `not_started` | — | 25 May 2026, 18:16 | Documented, but not yet wired into a running job |
| Corpus refresh | Merge scraped refs and confirmed flash labels | si-image-trainer-mvp | `not_started` | — | 25 May 2026, 18:16 | Core missing piece |
| Indexing | Build refreshed retrieval indexes automatically | si-image-trainer-mvp | `not_started` | — | 25 May 2026, 18:16 | Local building blocks exist |
| Indexing | Atomic index publication | si-image-trainer-mvp | `not_started` | — | 25 May 2026, 18:16 | Planned in docs only |
| Deployment | Reload inference with new indexes | si-image-trainer-mvp | `not_started` | — | 25 May 2026, 18:16 | Modal upload/reload path exists, not automated for this flow |
| Training | Periodic retraining with evaluation gate | si-image-trainer-mvp | `not_started` | — | 25 May 2026, 18:16 | Should be weekly or threshold-based, not daily |
| Orchestration | Connect discovery workflow to trainer refresh workflow | cross-repo | `not_started` | — | 25 May 2026, 18:16 | Likely `repository_dispatch` or trainer-side scheduled polling |

## Current Known Outputs

### From daily discovery

- Successful new local references discovered in the latest run: `0`
- Failed cities in the latest run: `none`
- Previously recovered missing reference: `MLGA_13`

### Latest known report path

- `tmp/daily-new-mosaics-report.json`

## Immediate Next Steps

1. Make the daily discovery pipeline robust for Paris and Málaga.
2. Finish wiring the daily workflow to commit and push new refs into the canonical repo.
3. Validate end-to-end R2 upload within the GitHub Actions workflow.
4. Build the trainer-side daily merged corpus refresh job.
5. Add automated index publication and inference reload.

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

## Update Rule

Whenever a task changes state:

1. Update the task row in this file.
2. Add a short bullet to the change log if the change is meaningful.
3. If the architecture itself changed, also update `docs/ref-corpus-automation-plan.md`.
