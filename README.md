# Runner Radar

**A live radar for your self-hosted GitHub Actions runners, right inside Claude Code.**

You moved CI to your own machines to save money. Now the questions are different:
*Is a runner down? Which job is it stuck on? Why has my PR been "Queued" for ten minutes?*
GitHub's UI answers that one repo at a time. Runner Radar answers it for your whole fleet,
in a pane beside your Claude Code session.

```
✖ box-2 is offline · 2 jobs waiting (longest 12m04s)

Runners  1 of 2 online · 1 working
  ● box-1   working  api › tests             3m12s
  ● box-2   offline

Waiting for a runner  2 jobs
  12m04s  web › e2e    · no runner has the label "gpu"
   1m40s  api › lint   · its runner is working, it's next

Repositories  3 watched · last 5 runs
  ● api    ✓✓✗✓✓  1 running · 1 waiting
  ● docs   ✓✓✓✓✓  no activity
  ● web    ✗✓✓    no activity
      ✗ CI · main · failed 12m ago in "e2e" › "Run tests"
        view on GitHub  ·  logs: /radar logs web

Hosted equivalent  this month (UTC) · hypothetical, not a bill
  ≈ $38.40 estimated GitHub-hosted equivalent · 6,400 min on your runners
     today $7.37 · 1,228 min
     api $23.40 · web $9.60 · docs $5.40
     last complete update 15:04:01
     all runs created since 2026-10-02 counted
     public repos and included plan minutes may mean $0 extra; hardware and power not subtracted
     at $0.006/min, your comparison rate · /radar savings for details

Updated 15:04:05 · refreshes every 30s · /radar off to stop
```

Plain words only: a runner is **free**, **working** or **offline**. The pane also speaks Spanish (`/radar es`, or the *Language* option).

## What it shows

- **A headline that answers first**: ✔ all clear, ⚠ a long wait or a growing queue, ✖ a runner down or a job that can't start.
- **Why each job is waiting**, the question GitHub's UI doesn't answer: it compares the job's `runs-on` labels with your runners and tells you whether **no runner has those labels** (the job will never start), the matching runners are **offline**, or they are **all working** (it is next in line).
- **Runners**: free, working or offline (in words, not only colors), and for each working runner the repo, job and how long it has been running.
- **Queue**: jobs waiting for a **self-hosted** runner (GitHub-hosted jobs are left out), longest wait first, across every watched repo; the wait turns yellow at half the wait alert and red past it.
- **Repositories**: one row per watched repo, active ones first, with running/waiting jobs and the last five results.
- **What broke**: when a repo's latest run failed, the row says which workflow, branch, job and step failed and how long ago, with a link to the failed job on GitHub. `/radar logs <repo>` prints the failed steps' last log lines right in the conversation.
- **An estimated GitHub-hosted equivalent**: the minutes that ran on your self-hosted runners this month (and today), per repo, priced at a GitHub-hosted comparison rate you choose. It is a hypothetical figure, not a bill and not money saved (see [the estimate](#the-hosted-equivalent-estimate)). The pane and `/radar savings` say when totals are still incomplete, recalculating, paused, stale or failed, and when they were last updated successfully.
- **Status line**: `radar · 1/2 online · 1 working · 2 waiting · longest 12m04s`.
- **Toasts** when a runner goes offline (or comes back), when the queue reaches a threshold, or when a job has waited too long.

It works for organizations (org-level runners) and personal accounts (repo-level runners). When a repo runner query fails, the pane marks the inventory as incomplete and keeps the runners it could read. It does not claim a missing label is definitive while inventory is incomplete.

## Requirements

- **Claude Code v2.1.287 or later** (mods support).
- **The [GitHub CLI](https://cli.github.com/)**, signed in: `gh auth login`.
  For org-level runners the session needs the `admin:org` scope:

  ```
  gh auth refresh -h github.com -s admin:org
  ```

Runner Radar never reads or stores a token: every call goes through your own `gh` session.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install runner-radar --marketplace AldereteRuben/runner-radar
```

Answer `y` to add the marketplace, then pick a scope (user scope = every session). From a shell:

```
claude plugin install runner-radar --marketplace AldereteRuben/runner-radar
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `AldereteRuben/runner-radar`, then **Add plugin**.

## Use

| Command | What it does |
| --- | --- |
| `/radar` | Opens the pane and starts polling the configured owner |
| `/radar <owner>` | Watches another org or user for this session |
| `/radar es` · `/radar en` | Switches the language (Español / English) for this session |
| `/radar logs <repo>` | Shows the last log lines of the failed steps of the repo's latest run |
| `/radar savings` | This month's estimated GitHub-hosted equivalent: total, today, per repo, coverage, and how it is computed (also `/radar cost`; `/radar ahorro` or `/radar coste` in Spanish) |
| `/radar refresh` | Re-opens the pane and refreshes now |
| `/radar off` | Stops polling and closes the pane |

The pane keeps its headline visible at narrow widths. At 44 columns it switches to a compact view, and at 76 columns it shows the full detail view.

## Configure

`/plugin` → **Installed** → **runner-radar** → **Configure** (or the rows in `/config`):

| Option | Default | |
| --- | --- | --- |
| Language | en | `en` or `es` |
| GitHub owner | – | Org or user to watch |
| Repositories | *(auto)* | Comma-separated repo names. Empty = the most recently pushed repos |
| Max repos (auto mode) | 6 | How many repos auto mode watches |
| Refresh interval | 30 s | 15 to 600 s |
| Queue alert | 5 jobs | 0 turns it off |
| Wait alert | 10 min | 0 turns it off |
| Hosted-equivalent estimate | on | Shows the estimated GitHub-hosted equivalent of your self-hosted minutes |
| Comparison rate | $0.006/min | The GitHub-hosted rate the estimate uses. Default: standard Linux x64 2-core. For other runner types see [GitHub's runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing) |

**GitHub API usage**: self-hosted describes where jobs run; Runner Radar still calls GitHub's API through `gh`. At each refresh it lists runners once per watched repo, plus once at org level for an organization; scans each repo's runs once; then fetches jobs for up to 6 active runs per repo. Auto repo mode adds one repo-list call per refresh. With 6 repos in auto mode, that is up to 50 calls per refresh for an organization (49 for a personal account), before failed-run detail lookups. If all six repos have a newly failed run, those add up to 6 more calls: up to 56 (org) or 55 (personal), or 6,720 / 6,600 per hour at the 30-second default. The first refresh can add one call to identify the owner type. Most refreshes use fewer calls because they have fewer than six active runs per repo; successful failed-run lookups are cached.

GitHub's standard authenticated REST API limit is 5,000 requests per hour for personal access tokens and user-authorized apps, shared with other tools using the same account ([GitHub rate limit documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)). Busy fleets at a 30-second interval can exceed it. For busy repos, start at 60 seconds or longer and/or watch fewer repos. The limit and actual usage depend on your account and other API activity; the mod does not make a separate quota-check request. The estimate excludes the additional one-off call made by `/radar logs`. Every call asks `gh` for the response headers (`gh api --include`), so rate-limit details come at no extra request. If GitHub reports a rate limit, the pane explains it and **every** request (radar and estimate) stops at once until GitHub's `Retry-After`, or the `X-RateLimit-Reset` time when the quota is used up; without those headers it waits one minute. Only time ends a pause: a later successful refresh does not.

### Hosted-equivalent API budget

The estimate has a budget per owner within one running mod instance, shared by automatic passes, catch-up and manual commands. Request reservations are saved before dispatch and restored on reload. This is not an account-wide cap: switching owners, using multiple computers or running concurrent Claude sessions can increase aggregate usage; separate instances do not coordinate atomic reservations.

- **at most 30 requests per pass and 150 per rolling hour** (about 3% of the standard 5,000/hour), counting discovery pages, job pages, run re-checks and retries;
- it waits while a radar refresh is in flight, and pauses while GitHub reports fewer than 1,000 requests left, until the reset;
- after a rate limit or an error it does not catch up early; the next regular pass retries.

What it spends:

- **Normal pass** (every 5 minutes, history counted): 1 request per watched repo for its newest 100 runs, plus 1 per newly finished run (and 1 per further 100 jobs of that run), plus 1 per unfinished run that dropped off the newest page (at most every 5 minutes). Once a day it lists the whole window again (1 request per 100 runs per repo) to find re-runs of older runs. With 6 repos that is about 72 requests an hour plus one per new finished run, capped at 150.
- **Catching up** (first use, a new repo, the 0.3.0 cache being rebuilt): a pass a minute, up to 30 requests each, stopped by the 150/hour cap. A backlog of *N* runs takes about *N* + *N*/100 requests, so roughly *N*/150 hours; the pane shows how many runs are counted and how far back history is listed until it is complete.
- With many watched repos (e.g. 20) most of the hourly budget goes to the newest-runs check, so totals update more slowly; they stay correct.

Progress (the history cursor of each repo, every run seen, and job pages already fetched) is kept in the mod's store per owner and repo, so a pass, a reload or a restart resumes where the last one stopped, and nothing is fetched or added twice.

### The hosted-equivalent estimate

It answers one question: *what would the minutes my self-hosted runners ran this month cost at a GitHub-hosted rate?* It is a hypothetical figure, not a bill and not money saved:

- Standard GitHub-hosted runners are free for public repositories, and the minutes included in your plan may mean the same jobs would have cost nothing extra.
- Your hardware, power and maintenance costs are not subtracted, and your machines may not perform like the hosted runner size you compare against.
- The default rate is $0.006/min, GitHub's standard Linux x64 2-core runner; change it to compare with another SKU (see [runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing) and [how Actions is billed](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).

How it counts (an estimate, not an invoice reconciliation):

- Every job of every attempt of a run (`filter=all`, all pages), on self-hosted runners; GitHub-hosted minutes are shown separately.
- Each job's run time (`completed_at − started_at`) is rounded up to the whole minute **once**, and the whole job is assigned to the **UTC day it finished**. A job that crosses midnight or the month end is never split, so it is never rounded twice.
- A run is final only after every job page was fetched for its latest attempt. A failed page keeps it pending (and resumes at that page). When a run is re-run, its new attempt is detected and the run is recounted, replacing its earlier count: the totals grow by the new attempt exactly once. A finished day's total can still change if GitHub later reports different job data.
- Coverage: runs created since 30 days before the UTC month start (GitHub allows re-running a run up to 30 days after it was created), so runs created before the month but executed in it are found. A re-run of a run that is no longer among a repo's newest 100 is found by the daily re-check, so it can appear up to a day late. A run created before that window that still executes this month is not counted. Totals cover the repos being watched.

At terminal widths below 44 columns, Runner Radar shows the headline and a short note to widen the pane. From 44 to 75 columns it uses a compact layout; at 76 columns and above it shows full details.

## What's new in 0.3.1

- **Honest wording**: "saved" is now an **estimated GitHub-hosted equivalent** (*coste equivalente estimado*), with the public-repo, included-minutes and hardware caveats in the pane and in `/radar savings`. The options are now *Hosted-equivalent estimate* and *Comparison rate* (same keys and defaults).
- **Complete history**: no more 300-runs-per-repo cap. History is scanned with a resumable cursor, jobs beyond 100 per run (all attempts) are paged in full, and a run is never final after a partial fetch or an error. Re-runs are recounted exactly once.
- **Dated by execution**: minutes count on the UTC day each job finished, not the day the run was created; runs created before the month but executed in it, and re-runs of older runs, are found.
- **Bounded API use**: a documented budget of 30 requests per pass and 150 per hour for the estimate, manual commands included; it yields to the live radar. A rate limit stops all requests at once, honors `Retry-After` / `X-RateLimit-Reset`, and is never cleared by a later successful refresh.
- **Visible state**: incomplete, recalculating, paused, stale and failed states, the last successful update and the coverage are shown in English and Spanish, in the pane and the command.
- The 0.3.0 cache (dated by run creation) is dropped and rebuilt automatically; the pane says it is recalculating meanwhile.

## What's new in 0.3.0

- **Hosted-equivalent counter** (first released as a "savings" counter; see 0.3.1 for the corrected wording): self-hosted minutes this month and today priced at a GitHub-hosted rate, per repo, in the pane and with `/radar savings` (`/radar ahorro`).
- New options for the counter (on/off) and the per-minute comparison rate.

## What's new in 0.2.0

- Shows when repo runner inventory is incomplete, while retaining data from successful queries.
- Counts only recognized pending self-hosted jobs in the queue.
- Gives clearer, localized GitHub permission, authentication, network, and rate-limit errors.
- Adapts the pane to narrow terminal widths and documents the API call budget.

## How it works

Runner Radar is a [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview): TypeScript that runs inside Claude Code and draws its own pane. It polls the GitHub REST API through `gh api`:

- `orgs/<owner>/actions/runners` and `repos/<owner>/<repo>/actions/runners` for the fleet,
- `repos/<owner>/<repo>/actions/runs` and `…/runs/<id>/jobs` for what is running and waiting,
- the same endpoints (`runs?created=…`, `runs/<id>`, `runs/<id>/jobs?filter=all`) for the hosted-equivalent estimate.

Nothing leaves your machine except those GitHub API calls.

## Develop

```
git clone https://github.com/AldereteRuben/runner-radar
cd runner-radar
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

[MIT](./LICENSE)
