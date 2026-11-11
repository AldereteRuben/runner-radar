import type { ApiError, ErrorKind, Job, Runner, Snapshot } from '../types'
import type { Strings } from './i18n'

// Pure functions over a snapshot: no `$`, no GitHub, easy to test. Every phrase
// comes from `Strings`, so the logic stays the same in every language.

// ── Job status ──────────────────────────────────────────────────

/**
 * The job statuses that mean "waiting for a runner": the only ones counted as
 * queue. Everything else (`in_progress`, `completed`, a conclusion such as
 * `success` / `failure` / `cancelled` / `skipped`, or a status GitHub adds later)
 * is not queue.
 */
export const PENDING_STATUSES: readonly string[] = ['queued', 'waiting', 'pending', 'requested']
const PENDING = new Set(PENDING_STATUSES)

export const isPending = (status: string): boolean => PENDING.has(status)

/** Statuses of runs and jobs the radar keeps: pending ones plus running ones. */
export const isActive = (status: string): boolean => isPending(status) || status === 'in_progress'

// ── Errors ──────────────────────────────────────────────────────

/** Sorts gh's error text into a kind the pane can explain in plain words. */
export function classify(raw: string): ErrorKind {
  const s = raw.toLowerCase()
  if (/rate limit|secondary rate|abuse detection|http 429/.test(s)) return 'rateLimit'
  if (/gh cli not found|enoent|executable file not found/.test(s)) return 'ghMissing'
  if (/http 401|bad credentials|gh auth login|not logged in|authentication required/.test(s)) return 'auth'
  if (/http 403|forbidden|must have admin|resource not accessible/.test(s)) return 'forbidden'
  if (/http 404|not found/.test(s)) return 'notFound'
  if (/timed? ?out|timeout|etimedout|econnreset|enotfound|econnrefused|error connecting|could not resolve|network|http 50[234]/.test(s))
    return 'network'
  if (/unexpected response/.test(s)) return 'unexpected'
  return 'other'
}

export const apiError = (raw: string): ApiError => ({ kind: classify(raw), detail: raw })

/** An org runner list failure: a permission problem means the admin:org scope. */
export function orgRunnerError(raw: string): ApiError {
  const e = apiError(raw)
  if (e.kind === 'forbidden' || e.kind === 'notFound' || /admin:org/i.test(raw)) return { kind: 'orgScope', detail: raw }
  return e
}

export const explain = (e: ApiError, t: Strings): string => t.error[e.kind](e.detail)

// ── Runner inventory ────────────────────────────────────────────

/**
 * How much of the fleet the snapshot saw: `complete`; `partial` when some repo
 * runner lists failed (what we have is real, but a runner may be missing); or
 * `unknown` when the org list (or the whole refresh) failed.
 */
export function inventory(s: Snapshot): 'complete' | 'partial' | 'unknown' {
  if (s.error) return 'unknown'
  if (s.runnerErrors.length > 0) return 'partial'
  return 'complete'
}

/** The pane's warning when some repo runner lists could not be read. */
export function partialWarning(s: Snapshot, t: Strings): string | undefined {
  if (s.runnerErrors.length === 0) return undefined
  const repos = s.runnerErrors.map(e => e.repo)
  const shown = repos.length > 3 ? [...repos.slice(0, 3), `+${repos.length - 3}`] : repos
  const kinds = new Set(s.runnerErrors.map(e => e.error.kind))
  const first = s.runnerErrors[0]
  const why = kinds.size === 1 && first ? explain(first.error, t) : ''
  return t.runnersPartial(shown, why)
}

/** `4m10s`, `1h02m`, `35s`. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** Self-hosted jobs in a pending status (see `PENDING_STATUSES`), longest waiting first. */
export function queue(s: Snapshot): Job[] {
  return s.jobs.filter(j => j.selfHosted && isPending(j.status)).sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Runs GitHub holds in a pending status without having created their jobs yet,
 * across the watched repos: how many, and when the oldest was created (0 when
 * none). They are not in `queue`: there is no job for a runner to take.
 */
export function unscheduled(s: Snapshot): { count: number; since: number } {
  let count = 0
  let since = 0
  for (const r of s.repos) {
    if (!r.unscheduled) continue
    count += r.unscheduled
    if (r.unscheduledSince && (!since || r.unscheduledSince < since)) since = r.unscheduledSince
  }
  return { count, since }
}

/** The job each busy runner is working on, by runner name. */
export function assignments(s: Snapshot): Map<string, Job> {
  const map = new Map<string, Job>()
  for (const j of s.jobs) if (j.status === 'in_progress' && j.runner) map.set(j.runner, j)
  return map
}

export function statusLine(s: Snapshot, now: number, t: Strings): string {
  const waiting = queue(s)
  const oldest = waiting[0]
  const base = t.status(
    s.runners.filter(r => r.online).length,
    s.runners.length,
    s.runners.filter(r => r.busy).length,
    waiting.length,
    oldest ? duration(now - oldest.createdAt) : '',
  )
  const held = unscheduled(s).count
  const line = held ? `${base} · ${t.statusUnscheduled(held)}` : base
  if (s.error) return `${line} · ${explain(s.error, t)}`
  if (inventory(s) === 'partial') return `${line} · ${t.statusPartial}`
  const repoErrors = s.repos.filter(r => r.error).length
  return repoErrors ? `${line} · ${t.headline.repoErrors(repoErrors)}` : line
}

const lower = (xs: string[]) => xs.map(x => x.toLowerCase())

/**
 * Why a queued self-hosted job is still waiting, from the runners we can see:
 * a label no runner has (it will never start), matching runners offline, or all
 * of them working. `undefined` when a free runner fits (it is about to start).
 *
 * With `partial` (some runner lists failed) a missing label or offline runners
 * are only what we can see: the reason says so and never blocks.
 */
export function waitReason(
  job: Job,
  runners: Runner[],
  t: Strings,
  partial = false,
): { text: string; blocking: boolean } | undefined {
  const wanted = lower(job.labels)
  const fits = runners.filter(r => {
    const has = new Set(lower(r.labels))
    return wanted.every(l => has.has(l))
  })
  if (fits.length === 0) {
    const missing = job.labels.filter(l => !runners.some(r => lower(r.labels).includes(l.toLowerCase())))
    const named = missing.length ? missing : job.labels.filter(l => l.toLowerCase() !== 'self-hosted')
    const shown = named.length ? named : job.labels
    if (partial) return { text: t.reason.noVisibleLabel(shown), blocking: false }
    return { text: t.reason.noLabel(shown), blocking: true }
  }
  const online = fits.filter(r => r.online)
  if (online.length === 0) {
    if (partial) return { text: t.reason.offlineVisible, blocking: false }
    return { text: t.reason.offline, blocking: true }
  }
  if (online.every(r => r.busy)) return { text: t.reason.working(online.length), blocking: false }
  return undefined
}

/**
 * The wait reason the snapshot supports: none when the runner inventory is
 * unknown, a hedged one when it is partial. Pane and headline both use this.
 */
export function reasonFor(job: Job, s: Snapshot, t: Strings): { text: string; blocking: boolean } | undefined {
  const inv = inventory(s)
  if (inv === 'unknown') return undefined
  return waitReason(job, s.runners, t, inv === 'partial')
}

export type Level = 'ok' | 'warn' | 'bad'

export type AlertConfig = { queueAlert: number; waitAlertMinutes: number }

/** How bad a wait is: past the wait alert is bad, past half of it a warning. */
export function waitLevel(waitMs: number, waitAlertMinutes: number): Level {
  const limit = (waitAlertMinutes > 0 ? waitAlertMinutes : 10) * 60_000
  if (waitMs >= limit) return 'bad'
  if (waitMs >= limit / 2) return 'warn'
  return 'ok'
}

/** One line that answers "is anything wrong?" before reading the rest. */
export function headline(s: Snapshot, now: number, config: AlertConfig, t: Strings): { level: Level; text: string } {
  const offline = s.runners.filter(r => !r.online)
  const waiting = queue(s)
  const stuck = waiting.filter(j => reasonFor(j, s, t)?.blocking)
  const oldest = waiting[0]
  const wait = oldest ? t.headline.waiting(waiting.length, duration(now - oldest.createdAt)) : ''
  const partial = s.runnerErrors.length ? t.headline.partial(s.runnerErrors.length) : ''
  const repoErrors = s.repos.filter(r => r.error).length
  const scanWarning = repoErrors ? t.headline.repoErrors(repoErrors) : ''
  const pending = unscheduled(s)
  const held = pending.count ? t.headline.unscheduled(pending.count, duration(now - pending.since)) : ''

  const bad: string[] = []
  if (s.error && s.runners.length === 0) bad.push(explain(s.error, t))
  if (offline.length === 1 && offline[0]) bad.push(t.headline.runnerOffline(offline[0].name))
  if (offline.length > 1) bad.push(t.headline.runnersOffline(offline.length))
  if (stuck.length) bad.push(t.headline.cantStart(stuck.length))
  if (bad.length) return { level: 'bad', text: [...bad, wait, held, partial, scanWarning].filter(Boolean).join(' · ') }

  if (s.error) return { level: 'warn', text: [explain(s.error, t), wait, held].filter(Boolean).join(' · ') }

  // Partial inventory: never "all good", always say the list is incomplete.
  if (partial || scanWarning) return { level: 'warn', text: [wait, held, partial, scanWarning].filter(Boolean).join(' · ') }

  const longWait = oldest && waitLevel(now - oldest.createdAt, config.waitAlertMinutes) !== 'ok'
  const bigQueue = config.queueAlert > 0 && waiting.length >= config.queueAlert
  // Runs GitHub has not scheduled: a warning once the oldest has waited a while.
  const longHold = pending.count > 0 && waitLevel(now - pending.since, config.waitAlertMinutes) !== 'ok'
  const text = [wait, held].filter(Boolean).join(' · ')
  if (longWait || bigQueue || longHold) return { level: 'warn', text }
  if (text) return { level: 'ok', text }

  const busy = s.runners.filter(r => r.busy).length
  if (busy) return { level: 'ok', text: t.headline.working(busy, s.runners.length) }
  return { level: 'ok', text: t.headline.allClear(s.runners.filter(r => r.online).length) }
}

/** What already fired, so each alert shows once per episode. */
export type AlertMemory = { queueAlerted: boolean; waitAlerted: Set<number> }

export const freshMemory = (): AlertMemory => ({ queueAlerted: false, waitAlerted: new Set() })

/**
 * Toasts for what changed between two snapshots: a runner that went offline or
 * came back, the queue crossing its threshold, a job waiting past the limit.
 * Mutates `memory`.
 */
export function alerts(
  prev: Snapshot | null,
  next: Snapshot,
  now: number,
  config: AlertConfig,
  memory: AlertMemory,
  t: Strings,
): string[] {
  const out: string[] = []

  if (prev && prev.owner === next.owner) {
    const before = new Map(prev.runners.map((r): [string, Runner] => [r.name, r]))
    for (const r of next.runners) {
      const was = before.get(r.name)
      if (was?.online && !r.online) out.push(t.alert.wentOffline(r.name))
      if (was && !was.online && r.online) out.push(t.alert.backOnline(r.name))
    }
  }

  const waiting = queue(next)
  if (config.queueAlert > 0) {
    if (waiting.length >= config.queueAlert && !memory.queueAlerted) {
      out.push(t.alert.queue(waiting.length))
      memory.queueAlerted = true
    } else if (waiting.length < config.queueAlert) {
      memory.queueAlerted = false
    }
  }

  if (config.waitAlertMinutes > 0) {
    const limit = config.waitAlertMinutes * 60_000
    const stillWaiting = new Set(waiting.map(j => j.id))
    for (const id of memory.waitAlerted) if (!stillWaiting.has(id)) memory.waitAlerted.delete(id)
    for (const j of waiting) {
      if (now - j.createdAt >= limit && !memory.waitAlerted.has(j.id)) {
        out.push(t.alert.longWait(j.repo, j.name, duration(now - j.createdAt)))
        memory.waitAlerted.add(j.id)
      }
    }
  }

  return out
}

/** `✓` success, `✗` failure, `⊘` cancelled, `·` anything else. */
export function mark(conclusion: string): { glyph: string; color: string } {
  if (conclusion === 'success') return { glyph: '✓', color: 'green' }
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure')
    return { glyph: '✗', color: 'red' }
  if (conclusion === 'cancelled') return { glyph: '⊘', color: 'gray' }
  return { glyph: '·', color: 'gray' }
}

// ── Layout ──────────────────────────────────────────────────────

/** Below this many body columns the pane shows only the summary. */
export const MIN_COLUMNS = 40
/** From this many body columns every row keeps its detail on one line. */
export const FULL_COLUMNS = 72

/**
 * How the pane lays out at a body width: `full` rows; `compact` rows with
 * shorter columns and each wait reason on its own line; `summary`, only the
 * headline, status and warnings.
 */
export function layout(columns: number): 'full' | 'compact' | 'summary' {
  if (columns < MIN_COLUMNS) return 'summary'
  if (columns < FULL_COLUMNS) return 'compact'
  return 'full'
}

/** `text` cut to `max` cells with an ellipsis; empty when there is no room. */
export const cut = (text: string, max: number): string =>
  max <= 1 ? '' : text.length > max ? text.slice(0, max - 1) + '…' : text

export function parseRepos(value: unknown): string[] {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',')
  return list
    .map(x => String(x).trim())
    .filter(Boolean)
    .map(x => x.replace(/^.*\//, ''))
}
