import type { EngineInterface } from 'claude-code'

import type { ApiError, FailedJob, Failure, Job, RepoSummary, Runner, RunnerError } from '../types'
import { apiError, isActive, isPending, orgRunnerError } from './logic'

// Everything that talks to GitHub goes through the `gh` CLI, with the user's own
// session: the mod never stores or reads a token itself.
//
// API calls per refresh (the README's budget is computed from these):
//   ownerKind   1, after the first successful lookup for an owner (cached)
//   listRepos   1 in auto mode, 0 with a configured repo list
//   listRunners 1 for an org, plus 1 per watched repo
//   scanRepo    1 per watched repo, plus 1 per active run (at most
//               MAX_ACTIVE_RUNS_PER_REPO), plus 1 when the latest run failed and
//               that run was not looked up before

export type Gh = { ok: true; out: string } | { ok: false; error: string }

/** Active runs per repo whose jobs we fetch; caps the API cost of a busy repo. */
export const MAX_ACTIVE_RUNS_PER_REPO = 6

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
): Promise<{ runners: Runner[]; error?: ApiError; repoErrors: RunnerError[] }> {
  const byId = new Map<number, Runner>()
  let error: ApiError | undefined
  if (kind === 'org') {
    const r = parse<RawRunner[]>(await gh($, ['api', `orgs/${owner}/actions/runners`, '--jq', RUNNERS_JQ]))
    if (typeof r === 'string') error = orgRunnerError(r)
    else r.forEach(x => byId.set(x.id, toRunner(x)))
  }
  const perRepo = await Promise.all(
    repos.map(repo => gh($, ['api', `repos/${owner}/${repo}/actions/runners`, '--jq', RUNNERS_JQ])),
  )
  // A failed repo list is not "no runners there": keep it, so the pane can say
  // the inventory is partial, and keep every runner the other lists returned.
  const repoErrors: RunnerError[] = []
  perRepo.forEach((res, i) => {
    const r = parse<RawRunner[]>(res)
    if (typeof r !== 'string') r.forEach(x => byId.set(x.id, toRunner(x)))
    else repoErrors.push({ repo: repos[i] ?? '', error: apiError(r) })
  })
  return { runners: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)), error, repoErrors }
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

/**
 * Failed jobs of a run, with the step each failed on; preserves lookup errors
 * so the pane can show failures and apply the rate-limit cooldown.
 */
async function failedJobs(
  $: EngineInterface,
  owner: string,
  repo: string,
  runId: number,
): Promise<{ jobs: FailedJob[]; error?: ApiError }> {
  const r = parse<FailedJob[]>(
    await gh($, [
      'api',
      `repos/${owner}/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=50`,
      '--jq',
      '[.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out") | {name, url: .html_url, step: ([.steps[]? | select(.conclusion == "failure" or .conclusion == "timed_out") | .name][0] // "")}]',
    ]),
  )
  return typeof r === 'string' ? { jobs: [], error: apiError(r) } : { jobs: r }
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
// ── Savings: billable minutes of completed runs ─────────────────
//
// API calls per savings pass (every SAVINGS_EVERY_MS, not every refresh):
//   completedRuns 1 per watched repo per page (at most SAVINGS_MAX_PAGES)
//   runMinutes    1 per run not counted before (at most SAVINGS_RUNS_PER_PASS)

export const SAVINGS_MAX_PAGES = 3

/** Completed runs of a repo created on or after `sinceDay` (YYYY-MM-DD), newest first. */
export async function completedRuns(
  $: EngineInterface,
  owner: string,
  repo: string,
  sinceDay: string,
): Promise<{ runs: Array<{ id: number; created_at: string }>; error?: ApiError }> {
  const runs: Array<{ id: number; created_at: string }> = []
  for (let page = 1; page <= SAVINGS_MAX_PAGES; page++) {
    const r = parse<Array<{ id: number; created_at: string }>>(
      await gh($, [
        'api',
        `repos/${owner}/${repo}/actions/runs?status=completed&created=%3E%3D${sinceDay}&per_page=100&page=${page}`,
        '--jq',
        '[.workflow_runs[] | {id, created_at}]',
      ]),
    )
    if (typeof r === 'string') return { runs, error: apiError(r) }
    runs.push(...r)
    if (r.length < 100) break
  }
  return { runs }
}

/**
 * Billable minutes of one run, split by where its jobs ran. GitHub rounds each
 * job up to the whole minute, and every attempt (re-runs too) is billed.
 */
export async function runMinutes(
  $: EngineInterface,
  owner: string,
  repo: string,
  runId: number,
): Promise<{ selfHosted: number; hosted: number } | { error: ApiError }> {
  const r = parse<Array<{ sh: boolean; s: number }>>(
    await gh($, [
      'api',
      `repos/${owner}/${repo}/actions/runs/${runId}/jobs?filter=all&per_page=100`,
      '--jq',
      '[.jobs[] | select(.started_at and .completed_at) | {sh: ((.labels | index("self-hosted")) != null), s: ((.completed_at | fromdateiso8601) - (.started_at | fromdateiso8601))}]',
    ]),
  )
  if (typeof r === 'string') return { error: apiError(r) }
  let selfHosted = 0
  let hosted = 0
  for (const job of r) {
    const minutes = billableMinutes(job.s)
    if (job.sh) selfHosted += minutes
    else hosted += minutes
  }
  return { selfHosted, hosted }
}

/** A job's billed minutes: rounded up to the minute, nothing for a job that never ran. */
export const billableMinutes = (seconds: number): number => (seconds > 0 ? Math.ceil(seconds / 60) : 0)

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
    return { summary: { repo, running: 0, queued: 0, recent: [], error: apiError(runs) }, jobs: [] }
  }
  const active = runs.filter(r => isActive(r.status)).slice(0, MAX_ACTIVE_RUNS_PER_REPO)
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
      if (typeof r === 'string') return { jobs: [] as Job[], error: apiError(r) }
      return { jobs: r
        .filter(j => isActive(j.status))
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
        ), error: undefined as ApiError | undefined }
    }),
  )
  const jobs = jobLists.flatMap(result => result.jobs)
  const jobsError = jobLists.find(result => result.error)?.error

  // The latest completed run failed: say what and where (one call per failed run).
  let failure: Failure | undefined
  let failureError: ApiError | undefined
  const latest = runs.find(r => r.status === 'completed')
  if (latest && FAILED.has(latest.conclusion ?? '')) {
    let failed = failureCache.get(latest.id)
    if (!failed) {
      const looked = await failedJobs($, owner, repo, latest.id)
      if (looked.error) failureError = looked.error
      else {
        failed = looked.jobs
        failureCache.set(latest.id, looked.jobs)
      }
    }
    if (failed) {
      failure = {
        runId: latest.id,
        workflow: latest.name,
        branch: latest.head_branch ?? '',
        url: latest.html_url,
        at: time(latest.updated_at),
        jobs: failed,
      }
    }
  }

  return {
    summary: {
      repo,
      running: jobs.filter(j => j.status === 'in_progress').length,
      queued: jobs.filter(j => isPending(j.status)).length,
      recent,
      failure,
      error: jobsError ?? failureError,
    },
    jobs,
  }
}
