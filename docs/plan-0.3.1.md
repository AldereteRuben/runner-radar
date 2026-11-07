# Runner Radar 0.3.1: reliable hosted-cost estimates

Base: v0.3.0 / a20b8af. Work on fix/v0.3.1. Preserve existing radar behavior and English/Spanish support.

## 1. Bound API use and resume history scans
- Replace rescanning all pages during every one-minute catch-up with persisted per-owner/repo scan progress and a queue of unprocessed runs. Cache discovery results between catch-up batches.
- Share a request budget and rate-limit cooldown between radar and savings. Savings must yield to live monitoring. Set and document a concrete, testable savings request limit, including discovery pages, job pages, retries, and manual commands.
- On any rate-limit response, stop scheduling further requests immediately; honor retry/reset headers when available, otherwise back off conservatively. A successful concurrent radar refresh must not clear a cooldown set by savings. Prevent overlapping savings passes before the first asynchronous operation; handle stop/owner changes without stale publication or restarting catch-up.
- Document normal and catch-up API costs honestly. No separate quota polling on every refresh and no credential storage.

## 2. Complete pagination and transparent coverage
- The current three-page run cap hides history beyond 300 runs/repo. Preserve a resumable cursor/checkpoint so subsequent passes eventually cover all relevant history within the request budget.
- Paginate jobs beyond 100, including attempts. Never mark a run fully counted after a partial page fetch or error.
- Show incomplete/catching-up/stale/error state in both pane and /radar savings, including last successful update and meaningful coverage. Savings.error currently exists but must actually be rendered.
- Totals must be idempotent across refreshes/restarts. Track run_attempt or equivalent revision information: a previously counted run may be re-run later and must be reconciled without double counting. Do not promise a completed run's minutes can never change.
- Migrate or invalidate the old run-level cache safely and show recalculation while rebuilding.

## 3. Honest monetary wording
- Rename 'saved/ahorrados' to 'estimated GitHub-hosted equivalent/coste equivalente estimado' throughout pane, command, settings, README and release notes.
- Keep the configurable comparison rate and show the selected reference rate. Explain directly in the report that standard hosted runners are free for public repos and included plan usage may mean no additional charge; hardware, power and maintenance are excluded.
- Do not imply actual bill savings or assume all self-hosted hardware performs like the selected hosted SKU. Preserve $0.006/min Linux x64 2-core default unless official documentation changes.
- Verify current billing claims against https://docs.github.com/en/billing/reference/actions-runner-pricing and https://docs.github.com/en/billing/concepts/product-billing/github-actions .

## 4. Calendar attribution
- Stop attributing all minutes to workflow run.created_at. Aggregate job usage by a documented UTC execution-date convention, using job timestamps.
- Preserve per-job rounding exactly once; splitting a job across days/months must not round the same job twice. Document the allocation convention as an estimate, not exact invoice reconciliation.
- Discover workflows created before the month but executed during it, and later attempts of older runs. Avoid an unbounded history scan; retain unfinished/recent run state and expose any remaining coverage limitation.
- Tests must cover midnight, month-end, and an old run re-executed in the current month.

## Acceptance cases
1. More than 300 completed runs in a repo eventually counted, with incomplete state until fully covered.
2. More than 100 jobs/attempts in a run fully counted; page-two failure cannot silently finalize partial totals.
3. Repeated refreshes/restarts do not duplicate totals; a later attempt increases totals exactly once.
4. Backlog scanning stays within the documented savings request budget, including repeated manual commands.
5. Rate-limit during discovery stops subsequent calls; a concurrent successful radar refresh cannot erase cooldown.
6. Savings errors and stale/partial totals visible in both EN/ES pane and command.
7. UTC boundaries and old-run reruns assigned using job execution timestamps with invariant total rounded minutes.
8. UI clearly presents a hypothetical hosted equivalent, including public-repo and included-usage caveats.
9. Existing radar commands, queue and partial-error behavior remain intact.

## Delivery
- Implement focused changes with meaningful regression tests in tests/radar.test.tsx; avoid unrelated redesign.
- Update plugin version to 0.3.1 and README/release notes with behavior, assumptions and budget.
- Run claude plugin test ., claude plugin validate ., and git diff --check. Fix failures; report warnings separately.
- Read current code and applicable project instructions first. Main Codex session owns git/release actions: leave changes reviewable on fix/v0.3.1; do not commit, push, merge, tag or publish.
- Return changed files, validation results, design choices/remaining limitations and exact next release steps. Publication follows review of this implementation by the coordinating session.
