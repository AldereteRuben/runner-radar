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

Savings  this month (UTC) vs. GitHub-hosted runners
  💰 $38.40 saved · 6,400 min on your runners
     today $7.37 · 1,228 min
     api $23.40 · web $9.60 · docs $5.40
     at $0.006/min, the GitHub-hosted Linux rate · /radar savings for details

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
- **How much your runners saved you**: the billable minutes that ran on your self-hosted runners this month (and today), priced at the GitHub-hosted rate they would have cost, per repo. It counts the way GitHub bills hosted runners: each job rounded up to the whole minute, every re-run included. `/radar savings` prints the breakdown and the assumptions.
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
| `/radar savings` | This month's savings vs. GitHub-hosted runners: total, today, per repo, and how it is computed (`/radar ahorro` in Spanish) |
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
| Savings counter | on | Shows what your runners saved vs. GitHub-hosted minutes |
| GitHub-hosted price | $0.006/min | The rate the counter compares against: GitHub-hosted Linux 2-core in 2026. Use 0.010 for Windows |

**GitHub API usage**: self-hosted describes where jobs run; Runner Radar still calls GitHub's API through `gh`. At each refresh it lists runners once per watched repo, plus once at org level for an organization; scans each repo's runs once; then fetches jobs for up to 6 active runs per repo. Auto repo mode adds one repo-list call per refresh. With 6 repos in auto mode, that is up to 50 calls per refresh for an organization (49 for a personal account), before failed-run detail lookups. If all six repos have a newly failed run, those add up to 6 more calls: up to 56 (org) or 55 (personal), or 6,720 / 6,600 per hour at the 30-second default. The first refresh can add one call to identify the owner type. Most refreshes use fewer calls because they have fewer than six active runs per repo; successful failed-run lookups are cached.

GitHub's standard authenticated REST API limit is 5,000 requests per hour for personal access tokens and user-authorized apps, shared with other tools using the same account ([GitHub rate limit documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)). Busy fleets at a 30-second interval can exceed it. For busy repos, start at 60 seconds or longer and/or watch fewer repos. The limit and actual usage depend on your account and other API activity; the mod does not make a separate quota-check request. The estimate excludes the additional one-off call made by `/radar logs`. If GitHub reports a rate limit, the pane explains it and pauses requests for one minute before retrying.

**Savings counter budget**: it runs on its own clock, every 5 minutes (not every refresh). Each pass lists this month's completed runs of the watched repos (1 call per repo per 100 runs, up to 3 pages) and looks up the jobs of runs it has not counted yet, at most 25 per pass, once per run: their minutes are kept in the mod's store by run id, so a finished run is never fetched again. A month's backlog fills in over a few passes, a minute apart, and the pane says how many runs are left. Only the current and previous month are kept.

The figure is an estimate of what the same minutes would have cost on GitHub-hosted runners at the price you set; it is not a bill. Self-hosted minutes themselves are free on GitHub today (a proposed per-minute self-hosted charge was postponed in December 2025 and has not taken effect). It does not subtract your plan's included free minutes or your machine's electricity.

At terminal widths below 44 columns, Runner Radar shows the headline and a short note to widen the pane. From 44 to 75 columns it uses a compact layout; at 76 columns and above it shows full details.

## What's new in 0.3.0

- **Savings counter**: how much your self-hosted runners saved this month and today vs. GitHub-hosted minutes, per repo, in the pane and with `/radar savings` (`/radar ahorro`).
- New options: *Savings counter* (on/off) and *GitHub-hosted price* per minute.
- Each finished run is counted once and kept by run id, so the counter adds few API calls.

## What's new in 0.2.0

- Shows when repo runner inventory is incomplete, while retaining data from successful queries.
- Counts only recognized pending self-hosted jobs in the queue.
- Gives clearer, localized GitHub permission, authentication, network, and rate-limit errors.
- Adapts the pane to narrow terminal widths and documents the API call budget.

## How it works

Runner Radar is a [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview): TypeScript that runs inside Claude Code and draws its own pane. It polls the GitHub REST API through `gh api`:

- `orgs/<owner>/actions/runners` and `repos/<owner>/<repo>/actions/runners` for the fleet,
- `repos/<owner>/<repo>/actions/runs` and `…/runs/<id>/jobs` for what is running and waiting.

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
