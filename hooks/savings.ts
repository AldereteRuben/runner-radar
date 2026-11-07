import type { ApiError, Savings, SavingsPause } from '../types'
import { type CountedJob, type ListedRun, PAGE } from './github'

// Pure helpers for the hosted-equivalent estimate: no `$`, no GitHub.
//
// The estimate answers "what would these minutes cost at a GitHub-hosted rate?"
// It is hypothetical: standard hosted runners are free for public repos, plan
// minutes may cover them, and hardware, power and upkeep are not subtracted.
//
// Calendar convention (an estimate, not invoice reconciliation): each job's run
// time (completed_at - started_at) is rounded up to the whole minute once, and
// the whole job is assigned to the UTC day its `completed_at` falls on. A job
// is never split across days, so it is never rounded twice. Every attempt of a
// run is counted (`filter=all`).
//
// Coverage: runs created on or after WINDOW_DAYS before the UTC month start,
// since GitHub only allows re-running a run within 30 days of its creation. A
// run created earlier that still executes this month is not counted.

/** GitHub's Linux x64 2-core hosted rate, USD/min (the default comparison rate). */
export const DEFAULT_PRICE_PER_MINUTE = 0.006

// ── Request budget (the README documents these numbers) ─────────

/** Most requests one counter pass makes: discovery pages, job pages, run checks and retries. */
export const SAVINGS_CALLS_PER_PASS = 30
/** Most counter requests in any rolling hour, passes started by `/radar savings` included. */
export const SAVINGS_CALLS_PER_HOUR = 150
/** The counter pauses while GitHub reports fewer requests left than this: the radar comes first. */
export const SAVINGS_QUOTA_RESERVE = 1000
export const HOUR_MS = 3_600_000

/** History looked at before the month start: the re-run limit of a run. */
export const WINDOW_DAYS = 30
/** Every so often the whole window is listed again, to find re-runs of older runs. */
export const RESWEEP_MS = 24 * HOUR_MS
/** An unfinished run not on the newest page is checked again at most this often. */
export const RECHECK_MS = 5 * 60_000
/** Overlap between head scans, for clock differences and same-second runs. */
export const HEAD_OVERLAP_MS = 10 * 60_000
/** A run search returns at most this many pages (GitHub's 1,000-result cap). */
export const MAX_SEARCH_PAGES = 10

const DAY_MS = 86_400_000
const pad2 = (n: number) => String(n).padStart(2, '0')

/** `YYYY-MM` of a time, in UTC. */
export const monthKey = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`
}

/** `YYYY-MM-DD` of a time, in UTC. */
export const dayKey = (ms: number): string => {
  const d = new Date(ms)
  return `${monthKey(ms)}-${pad2(d.getUTCDate())}`
}

export const monthStart = (ms: number): number => {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

/** The oldest creation time of a run that can still add minutes to this month. */
export const windowStart = (now: number): number => monthStart(now) - WINDOW_DAYS * DAY_MS

/** A job's billed minutes: rounded up to the minute, nothing for a job that never ran. */
export const billableMinutes = (seconds: number): number => (seconds > 0 ? Math.ceil(seconds / 60) : 0)

// ── Stored state ────────────────────────────────────────────────

/** Minutes by UTC day: [self-hosted, GitHub-hosted]. */
export type Days = Record<string, [number, number]>

/** A job fetch in progress: resumes at `page`, restarts if the run changes. */
export type JobProgress = { a: number; page: number; total: number; n: number; maxA: number; d: Days }

/**
 * One run: creation time, attempt, status, last time seen, whether `d` is the
 * final count of attempt `a`, its minutes, and a job fetch in progress.
 */
export type RunRec = { c: number; a: number; st: string; k: number; f: boolean; d?: Days; p?: JobProgress }

/** A range of creation times still to list, newest first; `low` is the oldest run seen so far. */
export type Segment = { from: number; to: number; page: number; low?: number; resweep?: boolean }

export type RepoState = {
  v: 2
  /** Newest creation time seen on a head scan. */
  head?: number
  /** Ranges still to list. */
  segs: Segment[]
  /** The window start of the last finished full scan: history is complete back to it. */
  full?: number
  /** When the last full scan finished. */
  swept?: number
  /** The window start of the scan in progress. */
  sweep?: number
  runs: Record<string, RunRec>
}

export type Meta = {
  v: 2
  /** Times of counter requests in the last hour: the shared hourly budget. */
  log: number[]
  /** The last pass that finished without an error. */
  ok: number
  /** Totals are being rebuilt after the 0.3.0 cache was dropped. */
  rebuilding: boolean
}

export const repoKey = (owner: string, repo: string): string => `scan2:${owner.toLowerCase()}:${repo.toLowerCase()}`
export const metaKey = (owner: string): string => `scan2meta:${owner.toLowerCase()}`
/** 0.3.0 kept run-level totals dated by run creation under these keys. */
export const legacyPrefix = (owner: string): string => `usage:${owner.toLowerCase()}:`

export const freshRepo = (): RepoState => ({ v: 2, segs: [], runs: {} })

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

function readDays(value: unknown): Days | undefined {
  if (!value || typeof value !== 'object') return undefined
  const out: Days = {}
  for (const [day, v] of Object.entries(value as Record<string, unknown>)) {
    if (/^\d{4}-\d\d-\d\d$/.test(day) && Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1])) {
      out[day] = [v[0], v[1]]
    }
  }
  return out
}

/** Reads a stored repo state defensively: anything malformed is dropped, not trusted. */
export function readRepo(value: unknown): RepoState {
  const v = value as Partial<RepoState> | undefined
  if (!v || typeof v !== 'object' || v.v !== 2 || !v.runs || typeof v.runs !== 'object') return freshRepo()
  const out: RepoState = { v: 2, segs: [], runs: {} }
  if (isNum(v.head)) out.head = v.head
  if (isNum(v.full)) out.full = v.full
  if (isNum(v.swept)) out.swept = v.swept
  if (isNum(v.sweep)) out.sweep = v.sweep
  if (Array.isArray(v.segs)) {
    for (const s of v.segs) {
      if (s && isNum(s.from) && isNum(s.to) && isNum(s.page) && s.page >= 1) {
        out.segs.push({ from: s.from, to: s.to, page: s.page, low: isNum(s.low) ? s.low : undefined, resweep: s.resweep === true || undefined })
      }
    }
  }
  for (const [id, r] of Object.entries(v.runs as Record<string, Partial<RunRec>>)) {
    if (!/^\d+$/.test(id) || !r || !isNum(r.c) || !isNum(r.a) || typeof r.st !== 'string' || !isNum(r.k)) continue
    const rec: RunRec = { c: r.c, a: r.a, st: r.st, k: r.k, f: r.f === true }
    const d = readDays(r.d)
    if (d) rec.d = d
    else rec.f = false
    const p = r.p
    if (p && isNum(p.a) && isNum(p.page) && isNum(p.total) && isNum(p.n) && isNum(p.maxA)) {
      const pd = readDays(p.d)
      if (pd) rec.p = { a: p.a, page: p.page, total: p.total, n: p.n, maxA: p.maxA, d: pd }
    }
    out.runs[id] = rec
  }
  return out
}

export function readMeta(value: unknown): Meta | undefined {
  const v = value as Partial<Meta> | undefined
  if (!v || typeof v !== 'object' || v.v !== 2) return undefined
  return {
    v: 2,
    log: Array.isArray(v.log) ? v.log.filter(isNum) : [],
    ok: isNum(v.ok) ? v.ok : 0,
    rebuilding: v.rebuilding === true,
  }
}

// ── Scan planning ───────────────────────────────────────────────

/**
 * Before a pass: move the window forward (a new month), drop what fell out of
 * it, and queue the daily re-check of the whole window.
 */
export function prepare(state: RepoState, win: number, now: number): RepoState {
  state.segs = state.segs.filter(s => s.to >= win).map(s => ({ ...s, from: Math.max(s.from, win) }))
  if (state.sweep !== undefined) state.sweep = Math.max(state.sweep, win)
  const month = dayKey(monthStart(now))
  for (const [id, r] of Object.entries(state.runs)) {
    if (r.c < win && !Object.keys(r.d ?? {}).some(day => day >= month)) delete state.runs[id]
  }
  const complete = isComplete(state, win)
  if (complete && state.head !== undefined && state.swept !== undefined && now - state.swept >= RESWEEP_MS && !state.segs.some(s => s.resweep)) {
    state.segs.push({ from: win, to: state.head, page: 1, resweep: true })
    state.sweep = win
  }
  return state
}

/** Records listed runs: new ones are queued, a newer attempt is queued for a recount. */
export function applyRuns(state: RepoState, runs: ListedRun[], win: number, now: number): void {
  for (const run of runs) {
    if (run.c < win || !run.c) continue
    const id = String(run.id)
    const rec = state.runs[id]
    if (!rec) {
      state.runs[id] = { c: run.c, a: run.a, st: run.st, k: now, f: false }
      continue
    }
    rec.k = now
    if (run.a > rec.a) {
      rec.a = run.a
      rec.f = false
    }
    if (run.st !== rec.st) {
      rec.st = run.st
      if (run.st !== 'completed') rec.f = false
    }
  }
}

/**
 * After the newest page of a repo: when more runs were created since the last
 * head scan than one page holds, queue the gap; on the first scan, queue the
 * whole window. Fewer runs than a page means nothing older exists.
 */
export function afterHead(state: RepoState, runs: ListedRun[], win: number, now: number): void {
  const unseen = runs.some(run => !state.runs[String(run.id)])
  applyRuns(state, runs, win, now)
  const times = runs.map(r => r.c).filter(Boolean)
  const first = state.head === undefined
  const gapFrom = first ? win : Math.max(win, (state.head ?? win) - HEAD_OVERLAP_MS)
  const oldest = times.length ? Math.min(...times) : undefined
  const advanced = first || unseen || times.some(time => time > (state.head ?? 0))
  if (advanced && runs.length >= PAGE && oldest !== undefined && oldest > gapFrom &&
      !state.segs.some(seg => seg.from <= gapFrom && seg.to >= oldest)) {
    state.segs.unshift({ from: gapFrom, to: oldest, page: 1 })
  }
  if (first) state.sweep = win
  if (state.segs.length === 0) finishSweep(state, now)
  if (times.length) state.head = Math.max(state.head ?? 0, ...times)
  else if (first) state.head = now
}

function finishSweep(state: RepoState, now: number): void {
  if (state.sweep === undefined) return
  state.full = Math.min(state.full ?? state.sweep, state.sweep)
  state.swept = now
  state.sweep = undefined
}

/** After one page of a segment: next page, a narrower range past the search cap, or done. */
export function stepSegment(state: RepoState, seg: Segment, runs: ListedRun[], win: number, now: number): void {
  applyRuns(state, runs, win, now)
  const times = runs.map(r => r.c).filter(Boolean)
  if (times.length) seg.low = Math.min(seg.low ?? Infinity, ...times)
  if (runs.length < PAGE) {
    state.segs = state.segs.filter(s => s !== seg)
  } else if (seg.page >= MAX_SEARCH_PAGES) {
    // Past 1,000 results: list again from the oldest run seen, from page 1.
    const to = Math.min(...times)
    seg.to = to < seg.to ? to : seg.to - 1000
    seg.page = 1
    if (seg.to < seg.from) state.segs = state.segs.filter(s => s !== seg)
  } else {
    seg.page++
  }
  if (state.segs.length === 0) finishSweep(state, now)
}

/** History is listed back to the window start, with no gap left. */
export const isComplete = (state: RepoState, win: number): boolean =>
  state.head !== undefined && state.full !== undefined && state.full <= win && state.segs.every(s => s.resweep)

export const needsCount = (r: RunRec): boolean => r.st === 'completed' && !r.f

// ── Counting jobs ───────────────────────────────────────────────

export const freshProgress = (attempt: number): JobProgress => ({ a: attempt, page: 1, total: -1, n: 0, maxA: 0, d: {} })

/** Adds one job's minutes to its UTC completion day, rounded once. */
export function addJob(d: Days, job: CountedJob): void {
  if (!job.st || !job.ct) return
  const start = Date.parse(job.st)
  const end = Date.parse(job.ct)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return
  const minutes = billableMinutes((end - start) / 1000)
  if (minutes === 0) return
  const day = dayKey(end)
  const slot = (d[day] ??= [0, 0])
  slot[job.sh ? 0 : 1] += minutes
}

/**
 * Adds one fetched page of jobs. `restart` when the run's job count changed
 * between pages (it was re-run meanwhile), `done` after the last page.
 */
export function addJobsPage(p: JobProgress, page: { total: number; jobs: CountedJob[] }): 'more' | 'done' | 'restart' {
  if (p.page > 1 && page.total !== p.total) return 'restart'
  p.total = page.total
  for (const job of page.jobs) {
    p.n++
    p.maxA = Math.max(p.maxA, job.a)
    addJob(p.d, job)
  }
  p.page++
  if (page.jobs.length < PAGE || (p.total >= 0 && p.n >= p.total)) return 'done'
  return 'more'
}

/**
 * Every page fetched: the run's minutes become its count, replacing any count
 * of an earlier attempt. Jobs of an attempt newer than the listed one mean the
 * run was re-run meanwhile: check it again instead of finalizing.
 */
export function finishCount(rec: RunRec, p: JobProgress): void {
  rec.p = undefined
  if (p.maxA > rec.a) {
    rec.a = p.maxA
    rec.st = 'unknown'
    rec.k = 0
    rec.f = false
    return
  }
  rec.d = p.d
  rec.f = true
}

// ── Totals ──────────────────────────────────────────────────────

export function summarize(
  repos: Array<{ repo: string; state: RepoState }>,
  input: {
    owner: string
    now: number
    pricePerMinute: number
    meta: Meta
    updatedAt: number
    error?: ApiError
    paused?: SavingsPause
  },
): Savings {
  const month = monthKey(input.now)
  const today = dayKey(input.now)
  const win = windowStart(input.now)
  let monthMinutes = 0
  let todayMinutes = 0
  let hostedMinutes = 0
  let runsCounted = 0
  let runsPending = 0
  let runsRunning = 0
  let scanning = 0
  let scannedBack: number | undefined
  const byRepo = new Map<string, number>()
  for (const { repo, state } of repos) {
    for (const r of Object.values(state.runs)) {
      if (r.f) runsCounted++
      else if (r.st === 'completed') runsPending++
      else runsRunning++
      // An earlier attempt's count stays in the totals until its recount replaces it.
      for (const [day, [sh, hosted]] of Object.entries(r.d ?? {})) {
        if (!day.startsWith(month)) continue
        monthMinutes += sh
        hostedMinutes += hosted
        if (day === today) todayMinutes += sh
        byRepo.set(repo, (byRepo.get(repo) ?? 0) + sh)
      }
    }
    if (!isComplete(state, win)) {
      scanning++
      const open = state.segs.filter(s => !s.resweep)
      const back = open.length ? Math.min(...open.map(s => s.low ?? s.to)) : (state.head ?? input.now)
      scannedBack = Math.min(scannedBack ?? Infinity, back)
    }
  }
  const perRepo = [...byRepo.entries()]
    .filter(([, minutes]) => minutes > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([repo, minutes]) => ({ repo, minutes }))
  const caughtUp = scanning === 0 && runsPending === 0
  return {
    owner: input.owner,
    month,
    pricePerMinute: input.pricePerMinute,
    monthMinutes,
    todayMinutes,
    hostedMinutes,
    perRepo,
    runsCounted,
    runsPending,
    runsRunning,
    coverage: caughtUp ? 'complete' : input.meta.rebuilding ? 'rebuilding' : 'catchingUp',
    historyFrom: dayKey(win),
    scannedBack: scannedBack !== undefined ? dayKey(Math.max(win, scannedBack)) : undefined,
    reposScanning: scanning,
    updatedAt: input.updatedAt,
    lastSuccessAt: input.meta.ok,
    paused: input.paused,
    error: input.error,
  }
}

/** `$38.40` (two decimals; a non-zero amount under a cent shows `<$0.01`). */
export function money(minutes: number, pricePerMinute: number): string {
  const usd = minutes * pricePerMinute
  if (usd > 0 && usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

/** `6,400` / `6.400`: thousands grouped with the language's separator. */
export function grouped(n: number, separator: string): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, separator)
}
