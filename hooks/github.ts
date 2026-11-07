import type { EngineInterface } from 'claude-code'

import type { FailedJob, Failure, Job, RepoSummary, Runner } from '../types'

// Everything that talks to GitHub goes through the `gh` CLI, with the user's own
// session: the mod never stores or reads a token itself.

export type Gh = { ok: true; out: string } | { ok: false; error: string }

/** Active runs per repo whose jobs we fetch; caps the API cost of a busy repo. */
const MAX_ACTIVE_RUNS_PER_REPO = 6
const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested'])

export async function gh($: EngineInterface, args: string[]): Promise<Gh> {
  try {
    const r = await $.process.run(['gh', ...args], { timeoutMs: 20_000 })
    if (r.exitCode !== 0) {
      const line = (r.stderr || r.stdout).trim().split('\n')[0]
      return { ok: false, error: line || `gh exited with ${r.exitCode}` }
    }
    return { ok: true, out: r.stdout }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: /ENOENT|not found|cannot start/i.test(message) ? 'gh CLI not found on PATH' : message }
  }
}

function parse<T>(r: Gh): T | string {
  if (!r.ok) return r.error
  try {
    return JSON.parse(r.out) as T
  } catch {
    return 'unexpected response from gh'
  }
}

const time = (iso: unknown): number => (typeof iso === 'string' ? Date.parse(iso) || 0 : 0)

/** 'org' when `owner` is an organization, 'user' otherwise. */
export async function ownerKind($: EngineInterface, owner: string): Promise<'org' | 'user' | string> {
  const r = parse<{ type?: string }>(await gh($, ['api', `users/${owner}`, '--jq', '{type}']))
  if (typeof r === 'string') return r
  return r.type === 'Organization' ? 'org' : 'user'
}

/** Repos to watch: the configured list, else the most recently pushed ones. */
export async function listRepos(
  $: EngineInterface,
  owner: string,
  kind: 'org' | 'user',
  configured: string[],
  max: number,
): Promise<string[] | string> {
  if (configured.length > 0) return configured
  const path =
    kind === 'org'
      ? `orgs/${owner}/repos?sort=pushed&per_page=${max * 2}`
      : `user/repos?affiliation=owner&sort=pushed&per_page=${max * 2}`
  const r = parse<Array<{ name: string; archived: boolean; owner: string }>>(
    await gh($, ['api', path, '--jq', '[.[] | {name, archived, owner: .owner.login}]']),
  )
  if (typeof r === 'string') return r
  return r
    .filter(x => !x.archived && x.owner.toLowerCase() === owner.toLowerCase())
    .slice(0, max)
    .map(x => x.name)
}

type RawRunner = { id: number; name: string; status: string; busy: boolean; labels: string[] }
const RUNNERS_JQ = '[.runners[] | {id, name, status, busy, labels: [.labels[].name]}]'

const toRunner = (x: RawRunner): Runner => ({
  id: x.id,
  name: x.name,
  online: x.status === 'online',
  busy: x.busy,
  labels: x.labels,
})

/**
 * Self-hosted runners: the org's (needs `admin:org` on the gh session), plus any
 * registered on the watched repos themselves (needs admin on each repo).
 */
export async function listRunners(
  $: EngineInterface,
  owner: string,
  kind: 'org' | 'user',
  repos: string[],
): Promise<{ runners: Runner[]; error?: string }> {
  const byId = new Map<number, Runner>()
  let error: string | undefined
  if (kind === 'org') {
    const r = parse<RawRunner[]>(await gh($, ['api', `orgs/${owner}/actions/runners`, '--jq', RUNNERS_JQ]))
    if (typeof r === 'string') error = /admin:org|403|404/.test(r) ? 'org runners need the admin:org scope (gh auth refresh -s admin:org)' : r
    else r.forEach(x => byId.set(x.id, toRunner(x)))
  }
  const perRepo = await Promise.all(
    repos.map(repo => gh($, ['api', `repos/${owner}/${repo}/actions/runners`, '--jq', RUNNERS_JQ])),
  )
  for (const res of perRepo) {
    const r = parse<RawRunner[]>(res)
    if (typeof r !== 'string') r.forEach(x => byId.set(x.id, toRunner(x)))
  }
  return { runners: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)), error }
}

type RawRun = {
  id: number
  name: string
  status: string
  conclusion: string | null
  created_at: string
  updated_at: string
  head_branch: string | null
  html_url: string
}

const FAILED = new Set(['failure', 'timed_out', 'startup_failure'])

/** Failed jobs of a run, with the step each failed on. Cached by run id by the caller. */
async function failedJobs($: EngineInterface, owner: string, repo: string, runId: number): Promise<FailedJob[]> {
  const r = parse<FailedJob[]>(
    await gh($, [
      'api',
      `repos/${owner}/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=50`,
      '--jq',
      '[.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out") | {name, url: .html_url, step: ([.steps[]? | select(.conclusion == "failure" or .conclusion == "timed_out") | .name][0] // "")}]',
    ]),
  )
  return typeof r === 'string' ? [] : r
}

/** The failed steps' log tail of a run, for `/radar logs`. */
export async function failedLog(
  $: EngineInterface,
  owner: string,
  repo: string,
  runId: number,
  lines: number,
): Promise<string[] | string> {
  const r = await gh($, ['run', 'view', String(runId), '-R', `${owner}/${repo}`, '--log-failed'])
  if (!r.ok) return r.error
  // gh prints "<job>\t<step>\t<timestamp> <line>"; keep the line itself.
  return r.out
    .split('\n')
    .map(l => l.split('\t').slice(2).join('\t').replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ''))
    .filter(l => l.trim() && !/^##\[(group|endgroup)\]/.test(l))
    .slice(-lines)
}
type RawJob = {
  id: number
  name: string
  status: string
  runner_name: string | null
  created_at: string
  started_at: string | null
  labels: string[]
}

/** One repo: its run counters, recent results, and the jobs of its active runs. */
export async function scanRepo(
  $: EngineInterface,
  owner: string,
  repo: string,
  failureCache: Map<number, FailedJob[]>,
): Promise<{ summary: RepoSummary; jobs: Job[] }> {
  const runs = parse<RawRun[]>(
    await gh($, [
      'api',
      `repos/${owner}/${repo}/actions/runs?per_page=20`,
      '--jq',
      '[.workflow_runs[] | {id, name, status, conclusion, created_at, updated_at, head_branch, html_url}]',
    ]),
  )
  if (typeof runs === 'string') {
    return { summary: { repo, running: 0, queued: 0, recent: [], error: runs }, jobs: [] }
  }
  const active = runs.filter(r => ACTIVE.has(r.status)).slice(0, MAX_ACTIVE_RUNS_PER_REPO)
  const recent = runs
    .filter(r => r.status === 'completed')
    .slice(0, 5)
    .map(r => r.conclusion ?? 'unknown')

  const jobLists = await Promise.all(
    active.map(async run => {
      const r = parse<RawJob[]>(
        await gh($, [
          'api',
          `repos/${owner}/${repo}/actions/runs/${run.id}/jobs?per_page=50`,
          '--jq',
          '[.jobs[] | {id, name, status, runner_name, created_at, started_at, labels}]',
        ]),
      )
      if (typeof r === 'string') return []
      return r
        .filter(j => ACTIVE.has(j.status))
        .map(
          (j): Job => ({
            id: j.id,
            repo,
            workflow: run.name,
            name: j.name,
            status: j.status,
            runner: j.runner_name ?? '',
            createdAt: time(j.created_at),
            startedAt: time(j.started_at),
            selfHosted: j.labels.includes('self-hosted'),
            labels: j.labels,
          }),
        )
    }),
  )
  const jobs = jobLists.flat()

  // The latest completed run failed: say what and where (one call per failed run).
  let failure: Failure | undefined
  const latest = runs.find(r => r.status === 'completed')
  if (latest && FAILED.has(latest.conclusion ?? '')) {
    let failed = failureCache.get(latest.id)
    if (!failed) {
      failed = await failedJobs($, owner, repo, latest.id)
      failureCache.set(latest.id, failed)
    }
    failure = {
      runId: latest.id,
      workflow: latest.name,
      branch: latest.head_branch ?? '',
      url: latest.html_url,
      at: time(latest.updated_at),
      jobs: failed,
    }
  }

  return {
    summary: {
      repo,
      running: jobs.filter(j => j.status === 'in_progress').length,
      queued: jobs.filter(j => j.status !== 'in_progress').length,
      recent,
      failure,
    },
    jobs,
  }
}
