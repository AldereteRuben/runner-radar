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
- **Status line**: `radar · 1/2 online · 1 working · 2 waiting · longest 12m04s`.
- **Toasts** when a runner goes offline (or comes back), when the queue reaches a threshold, or when a job has waited too long.

It works for organizations (org-level runners) and personal accounts (repo-level runners).

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
| `/radar refresh` | Re-opens the pane and refreshes now |
| `/radar off` | Stops polling and closes the pane |

The pane needs a terminal about 110 columns wide; when it does not fit, the status line still has the summary.

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

**API budget**: each refresh costs about one call per watched repo, plus one per active run (at most 6 per repo), plus the runner lists. With 6 repos every 30 s that is roughly 1,000 to 2,000 calls an hour, well inside GitHub's 5,000/hour for a signed-in user. Raise the interval if you watch many busy repos.

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
