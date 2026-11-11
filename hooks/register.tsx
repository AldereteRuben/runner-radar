import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { ApiError, FailedJob, RepoSummary, Savings, SavingsPause, Snapshot } from '../types'
import { failedLog, getRun, jobsPage, listRepos, listRunners, listRunsPage, ownerKind, scanRepo } from './github'
import { type Call, caller, DEFAULT_BACKOFF_MS, freshLimiter, type Gh, type Limiter, pause } from './limiter'
import {
  addJobsPage,
  afterHead,
  applyRuns,
  DEFAULT_PRICE_PER_MINUTE,
  finishCount,
  freshProgress,
  grouped,
  HOUR_MS,
  legacyPrefix,
  type Meta,
  metaKey,
  money,
  needsCount,
  prepare,
  readMeta,
  readRepo,
  RECHECK_MS,
  repoKey,
  type RepoState,
  type RunRec,
  SAVINGS_CALLS_PER_HOUR,
  SAVINGS_CALLS_PER_PASS,
  SAVINGS_QUOTA_RESERVE,
  stepSegment,
  summarize,
  windowStart,
} from './savings'
import { type Lang, parseLang, type Strings, strings } from './i18n'
import {
  type AlertMemory,
  alerts,
  assignments,
  apiError,
  classify,
  cut,
  duration,
  freshMemory,
  headline,
  explain,
  layout,
  partialWarning,
  type Level,
  mark,
  parseRepos,
  queue,
  reasonFor,
  statusLine,
  waitLevel,
} from './logic'

// Runner Radar: a live view of a self-hosted GitHub Actions runner fleet.
//   /radar            open the pane and start polling the configured owner
//   /radar <owner>    watch another org or user for this session
//   /radar es | en    switch the language for this session
//   /radar savings    the estimated GitHub-hosted equivalent of this month's minutes
//   /radar refresh    refresh now        /radar off    stop

const PANE = 'runner-radar'
const COMMAND = 'radar'

// Bump a shape tag when its value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const snapshot = atom({ plugin: 'runner-radar', key: 'snapshot' } as const, null, { shape: 'snapshot-3' })
const polling = atom({ plugin: 'runner-radar', key: 'polling' } as const, false, { shape: 'polling-1' })
const savingsAtom = atom({ plugin: 'runner-radar', key: 'savings' } as const, null, { shape: 'savings-2' })

/** A counter pass runs this often. */
const SAVINGS_EVERY_MS = 5 * 60_000
/** While runs or history are left to count, the next pass comes this soon. */
const SAVINGS_CATCH_UP_MS = 60_000
/** Totals older than this are shown as not updating. */
const SAVINGS_STALE_MS = 2 * SAVINGS_EVERY_MS + 60_000

type Config = {
  owner: string
  repos: string[]
  maxRepos: number
  intervalMs: number
  queueAlert: number
  waitAlertMinutes: number
  lang: Lang
  savingsOn: boolean
  pricePerMinute: number
}

const num = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function readConfig(options: PluginOptions): Config {
  return {
    owner: String(options.owner ?? '').trim(),
    repos: parseRepos(options.repos),
    maxRepos: num(options.max_repos, 6, 1, 20),
    intervalMs: num(options.interval_seconds, 30, 15, 600) * 1000,
    queueAlert: num(options.queue_alert, 5, 0, 100),
    waitAlertMinutes: num(options.wait_alert_minutes, 10, 0, 240),
    lang: parseLang(options.language),
    savingsOn: options.savings !== false,
    pricePerMinute: num(options.price_per_minute, DEFAULT_PRICE_PER_MINUTE, 0, 1),
  }
}

/** What one activation of the module keeps: starts over on every reload. */
type Radar = {
  config: Config
  timer: Timer | undefined
  inFlight: boolean
  /** The refresh in flight: the counter waits for it, live monitoring comes first. */
  refreshing: Promise<void> | undefined
  ownerOverride: string
  langOverride: Lang | undefined
  kinds: Map<string, 'org' | 'user'>
  memory: AlertMemory
  /** Shared by the radar and the counter: a rate limit hit by either pauses both. */
  limiter: Limiter
  /** Failed jobs per run id: a failed run is looked up once. */
  failureCache: Map<number, FailedJob[]>
  savingsTimer: Timer | undefined
  savingsSoon: Timer | undefined
  /** The counter pass in flight, for the generation it started in. */
  savingsPass: { gen: number; promise: Promise<void> } | undefined
  /** Bumped on stop and owner change: a pass of an older generation stops and publishes nothing. */
  savingsGen: number
}

const ownerOf = (radar: Radar): string => radar.ownerOverride || radar.config.owner
const textOf = (radar: Radar): Strings => strings(radar.langOverride ?? radar.config.lang)
const seconds = (radar: Radar): number => radar.config.intervalMs / 1000

async function refresh($: EngineInterface, radar: Radar): Promise<void> {
  const who = ownerOf(radar)
  if (!who || radar.inFlight) return
  radar.inFlight = true
  let done: () => void = () => {}
  radar.refreshing = new Promise<void>(resolve => {
    done = () => resolve()
  })
  const gh = caller($, radar.limiter)
  const empty = async (error: string): Promise<Snapshot> => ({
    owner: who,
    updatedAt: await $.clock.now(),
    runners: [],
    jobs: [],
    repos: [],
    error: apiError(error),
    runnerErrors: [],
  })
  // A rate limit seen without a cooldown set (the limiter sets one from the
  // headers as the response arrives): back off by default. Never shortens one.
  const coolDown = (s: Snapshot) => {
    if (hasRateLimit(s) && radar.limiter.until <= s.updatedAt) pause(radar.limiter, s.updatedAt + DEFAULT_BACKOFF_MS)
  }
  const publishError = async (error: string): Promise<Snapshot> => {
    const next = await empty(error)
    await publish($, radar, next)
    coolDown(next)
    return next
  }
  try {
    if ((await $.clock.now()) < radar.limiter.until) return
    let kind = radar.kinds.get(who)
    if (!kind) {
      const k = await ownerKind(gh, who)
      if (k !== 'org' && k !== 'user') return void (await publishError(k))
      kind = k
      radar.kinds.set(who, k)
    }
    const repos = await listRepos(gh, who, kind, radar.config.repos, radar.config.maxRepos)
    if (typeof repos === 'string') return void (await publishError(repos))
    const [fleet, scans] = await Promise.all([
      listRunners(gh, who, kind, repos),
      Promise.all(repos.map(repo => scanRepo(gh, who, repo, radar.failureCache))),
    ])
    const next: Snapshot = {
      owner: who,
      updatedAt: await $.clock.now(),
      runners: fleet.runners,
      jobs: scans.flatMap(s => s.jobs),
      repos: scans.map(s => s.summary),
      error: fleet.error,
      runnerErrors: fleet.repoErrors,
    }
    await publish($, radar, next)
    coolDown(next)
    // First data for this owner: count now instead of in five minutes.
    const sv = await read($, savingsAtom)
    if (radar.config.savingsOn && (!sv || sv.owner !== who)) kickSavings($, radar)
  } catch (err) {
    // A refresh runs unawaited from a timer: surface the failure in the pane.
    await publishError(err instanceof Error ? err.message : String(err))
  } finally {
    radar.inFlight = false
    radar.refreshing = undefined
    done()
  }
}

function hasRateLimit(s: Snapshot): boolean {
  return s.error?.kind === 'rateLimit' || s.runnerErrors.some(e => e.error.kind === 'rateLimit') ||
    s.repos.some(r => r.error?.kind === 'rateLimit')
}

async function publish($: EngineInterface, radar: Radar, next: Snapshot): Promise<void> {
  const t = textOf(radar)
  const prev = await read($, snapshot)
  await update($, snapshot, () => next)
  $.ui.status(statusLine(next, next.updatedAt, t))
  for (const text of alerts(prev, next, next.updatedAt, radar.config, radar.memory, t)) {
    $.ui.toast(text, { timeoutMs: 8000 })
  }
}

/** Starts a refresh in the background; it never rejects (the session may be gone). */
function kick($: EngineInterface, radar: Radar): void {
  refresh($, radar).catch(() => undefined)
}

// ── Hosted-equivalent counter ───────────────────────────────────

/** The counter's state for one owner; 0.3.0's run-level cache is dropped and rebuilt. */
async function loadMeta($: EngineInterface, who: string): Promise<Meta> {
  const meta = readMeta(await $.store.get(metaKey(who)))
  if (meta) return meta
  const prefix = legacyPrefix(who)
  const legacy = (await $.store.keys()).filter(k => k.startsWith(prefix))
  for (const key of legacy) await $.store.delete(key)
  return { v: 2, log: [], ok: 0, rebuilding: legacy.length > 0 }
}

/** A request the counter did not make (budget, cooldown, stop): never an error of its own. */
const SKIPPED: Gh = { ok: false, error: 'skipped by Runner Radar' }

/**
 * One counter pass, within SAVINGS_CALLS_PER_PASS requests and the rolling
 * SAVINGS_CALLS_PER_HOUR (kept in `$.store`, so `/radar savings` and reloads
 * share it):
 *   1. the newest page of runs of each watched repo: new runs, new attempts,
 *      finished runs, and any gap since the last pass;
 *   2. the jobs of runs to count, every page, newest runs first; a fetch cut
 *      short resumes at its page next pass, and nothing is final until the
 *      last page; unfinished runs are checked again every few minutes;
 *   3. older history, one page per repo in turn, resuming where it stopped;
 *   4. counting again with what is left.
 * Everything is kept by owner and repo in `$.store`; totals are recomputed from
 * it, so a refresh, a restart or a repeated command never counts a run twice.
 */
async function refreshSavings($: EngineInterface, radar: Radar): Promise<void> {
  if (!radar.config.savingsOn) return
  const gen = radar.savingsGen
  const who = ownerOf(radar)
  const s = await read($, snapshot)
  if (!who || !s || s.owner !== who || s.repos.length === 0) return
  const live = () => radar.savingsGen === gen && ownerOf(radar) === who && radar.config.savingsOn
  if (!live()) return
  const repos = s.repos.map(r => r.repo)
  const gh = caller($, radar.limiter)
  let now = await $.clock.now()
  const win = windowStart(now)
  const meta = await loadMeta($, who)
  const states = new Map<string, RepoState>()
  for (const repo of repos) states.set(repo, prepare(readRepo(await $.store.get(repoKey(who, repo))), win, now))
  const stateOf = (repo: string): RepoState => states.get(repo) as RepoState

  let error: ApiError | undefined
  let paused: SavingsPause | undefined
  let stopped = false
  let calls = 0
  const request: Call = async args => {
    // Live monitoring first: wait for a refresh in flight.
    while (!stopped && radar.refreshing) await radar.refreshing
    if (!stopped && !live()) stopped = true
    if (stopped) return SKIPPED
    now = await $.clock.now()
    meta.log = meta.log.filter(t => t > now - HOUR_MS)
    const quota = radar.limiter.quota
    if (now < radar.limiter.until) paused = { reason: 'rateLimit', until: radar.limiter.until }
    else if (quota && quota.remaining < SAVINGS_QUOTA_RESERVE && now < quota.reset) paused = { reason: 'quota', until: quota.reset }
    else if (meta.log.length >= SAVINGS_CALLS_PER_HOUR) paused = { reason: 'budget', until: (meta.log[0] ?? now) + HOUR_MS }
    if (paused || calls >= SAVINGS_CALLS_PER_PASS) {
      stopped = true
      return SKIPPED
    }
    calls++
    meta.log.push(now)
    // Reserve before dispatch so an interrupted pass cannot reset its budget.
    await $.store.set(metaKey(who), meta)
    if (!live()) { stopped = true; return SKIPPED }
    const r = await gh(args)
    if (!r.ok && classify(r.error) === 'rateLimit') {
      // Stop at once: no further request this pass, and the cooldown holds the radar too.
      error ??= apiError(r.error)
      paused = { reason: 'rateLimit', until: radar.limiter.until }
      stopped = true
    }
    return r
  }
  const fail = (e: ApiError) => {
    if (!stopped) error ??= e
  }
  // What failed is not tried again in the same pass.
  const failedRepos = new Set<string>()
  const failedRuns = new Set<string>()

  async function countRun(repo: string, id: string, rec: RunRec): Promise<ApiError | 'gone' | undefined> {
    let p = rec.p && rec.p.a === rec.a ? rec.p : freshProgress(rec.a)
    rec.p = p
    for (;;) {
      const r = await jobsPage(request, who, repo, Number(id), p.page)
      if ('error' in r) return r.error.kind === 'notFound' && !stopped ? 'gone' : r.error
      const step = addJobsPage(p, r)
      if (step === 'more') continue
      if (step === 'restart') {
        p = freshProgress(rec.a)
        rec.p = p
        continue
      }
      finishCount(rec, p)
      return undefined
    }
  }

  async function countRuns(): Promise<void> {
    const work = repos
      .filter(repo => !failedRepos.has(repo))
      .flatMap(repo => Object.entries(stateOf(repo).runs).map(([id, rec]) => ({ repo, id, rec })))
      .filter(w => !failedRuns.has(`${w.repo}/${w.id}`))
      .filter(w => needsCount(w.rec) || (w.rec.st !== 'completed' && now - w.rec.k >= RECHECK_MS))
      .sort((a, b) => (a.rec.p ? 0 : 1) - (b.rec.p ? 0 : 1) || b.rec.c - a.rec.c)
    for (const { repo, id, rec } of work) {
      if (stopped) return
      const runs = stateOf(repo).runs
      if (rec.st !== 'completed') {
        const g = await getRun(request, who, repo, Number(id))
        if ('error' in g) {
          if (g.error.kind === 'notFound' && !stopped) delete runs[id]
          else {
            fail(g.error)
            failedRuns.add(`${repo}/${id}`)
          }
          continue
        }
        applyRuns(stateOf(repo), [g.run], win, now)
        rec.k = now
        if (!needsCount(rec)) continue
      }
      const e = await countRun(repo, id, rec)
      if (e === 'gone') delete runs[id]
      else if (e) {
        fail(e)
        failedRuns.add(`${repo}/${id}`)
      }
    }
  }

  // 1. The newest runs of each repo.
  for (const repo of repos) {
    if (stopped) break
    const r = await listRunsPage(request, who, repo, 1)
    if ('error' in r) {
      fail(r.error)
      failedRepos.add(repo)
      continue
    }
    afterHead(stateOf(repo), r.runs, win, now)
  }
  // 2. Count what is known.
  await countRuns()
  // 3. Older history, a page per repo in turn.
  for (let progressed = true; progressed && !stopped; ) {
    progressed = false
    for (const repo of repos) {
      const state = stateOf(repo)
      const seg = state.segs[0]
      if (stopped || !seg || failedRepos.has(repo)) continue
      const r = await listRunsPage(request, who, repo, seg.page, seg)
      if ('error' in r) {
        fail(r.error)
        failedRepos.add(repo)
        continue
      }
      stepSegment(state, seg, r.runs, win, now)
      progressed = true
    }
  }
  // 4. Count what history found, with what is left of the pass.
  await countRuns()

  // Progress is kept even when the pass was cut short: it is this owner's data.
  for (const [repo, state] of states) await $.store.set(repoKey(who, repo), state)
  // A successful update: no error, and GitHub was actually asked (not held back by a pause).
  if (!error && (!paused || calls > 0)) meta.ok = now
  const result = summarize(
    repos.map(repo => ({ repo, state: stateOf(repo) })),
    { owner: who, now, pricePerMinute: radar.config.pricePerMinute, meta, updatedAt: now, error, paused },
  )
  if (result.coverage === 'complete') meta.rebuilding = false
  await $.store.set(metaKey(who), meta)
  // Stopped, or the owner changed meanwhile: publish nothing, schedule nothing.
  if (!live()) return
  await update($, savingsAtom, () => result)
  // Work left, no error and nothing paused: come back soon instead of in five
  // minutes. After an error the regular pass retries, so failures never loop.
  if (!paused && !error && calls > 0 && result.coverage !== 'complete' && radar.timer && !radar.savingsSoon) {
    radar.savingsSoon = $.clock.after(SAVINGS_CATCH_UP_MS, () => {
      radar.savingsSoon = undefined
      kickSavings($, radar)
    })
  }
}

/**
 * The counter pass of the current generation: an existing one is shared (never
 * two at once); one left from an older generation is waited for, then replaced.
 * The pass is registered before its first asynchronous step.
 */
function savingsPass($: EngineInterface, radar: Radar): Promise<void> {
  const current = radar.savingsPass
  if (current && current.gen === radar.savingsGen) return current.promise
  const gen = radar.savingsGen
  const before = current ? current.promise : Promise.resolve()
  const promise: Promise<void> = before
    .then(() => (radar.savingsGen === gen ? refreshSavings($, radar) : undefined))
    .catch(() => undefined)
    .finally(() => {
      if (radar.savingsPass?.promise === promise) radar.savingsPass = undefined
    })
  radar.savingsPass = { gen, promise }
  return promise
}

function kickSavings($: EngineInterface, radar: Radar): void {
  savingsPass($, radar).catch(() => undefined)
}

function start($: EngineInterface, radar: Radar): void {
  if (radar.timer) return
  radar.timer = $.clock.every(radar.config.intervalMs, () => kick($, radar))
  if (radar.config.savingsOn) radar.savingsTimer = $.clock.every(SAVINGS_EVERY_MS, () => kickSavings($, radar))
}

/** Ends the counter's current generation: a pass in flight stops and publishes nothing. */
function endSavingsGeneration(radar: Radar): void {
  radar.savingsGen++
  radar.savingsSoon?.cancel()
  radar.savingsSoon = undefined
}

function stop(radar: Radar): void {
  radar.timer?.cancel()
  radar.timer = undefined
  radar.savingsTimer?.cancel()
  radar.savingsTimer = undefined
  endSavingsGeneration(radar)
}

/** `15:04:05` today, `2026-11-06 15:04` another day (local time). */
function clockTime(ms: number, now: number): string {
  const d = new Date(ms)
  const time = d.toTimeString().slice(0, 8)
  if (d.toDateString() === new Date(now).toDateString()) return time
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${date} ${time.slice(0, 5)}`
}

/** What the counter's figures cover, and what is wrong with them: shared by the pane and the command. */
function savingsStatus(sv: Savings, now: number, t: Strings): Array<{ text: string; level: Level }> {
  const out: Array<{ text: string; level: Level }> = []
  const at = (ms: number) => clockTime(ms, now)
  if (sv.coverage === 'rebuilding') out.push({ text: t.savings.rebuilding, level: 'warn' })
  if (sv.coverage !== 'complete') {
    const parts = [t.savings.incomplete]
    if (sv.runsPending > 0) parts.push(t.savings.counting(sv.runsCounted, sv.runsCounted + sv.runsPending))
    if (sv.scannedBack) parts.push(t.savings.history(sv.scannedBack, sv.historyFrom))
    out.push({ text: parts.join(' · '), level: 'warn' })
  }
  if (sv.error) out.push({ text: t.savings.failed(explain(sv.error, t)), level: 'bad' })
  if (sv.paused) out.push({ text: t.savings.paused[sv.paused.reason](sv.paused.until ? at(sv.paused.until) : ''), level: 'warn' })
  if (sv.runsRunning > 0) out.push({ text: t.savings.running(sv.runsRunning), level: 'ok' })
  const stale = now - sv.updatedAt > SAVINGS_STALE_MS || (sv.lastSuccessAt > 0 && now - sv.lastSuccessAt > SAVINGS_STALE_MS)
  const last = t.savings.lastOk(sv.lastSuccessAt ? at(sv.lastSuccessAt) : t.savings.never)
  out.push({ text: stale ? `${t.savings.stale} · ${last}` : last, level: stale || !sv.lastSuccessAt ? 'warn' : 'ok' })
  if (sv.coverage === 'complete') out.push({ text: t.savings.complete(sv.historyFrom), level: 'ok' })
  return out
}

/** `/radar savings`: the month's hosted-equivalent estimate, its coverage and its assumptions. */
async function showSavings($: EngineInterface, radar: Radar): Promise<{ text: string }> {
  const t = textOf(radar)
  if (!radar.config.savingsOn) return { text: t.savings.off }
  const who = ownerOf(radar)
  if (!who) return { text: t.cmd.needOwner }
  await savingsPass($, radar)
  const sv = await read($, savingsAtom)
  if (!sv || sv.owner !== who) return { text: (await read($, snapshot)) ? t.asking : t.cmd.needOwner }
  const now = await $.clock.now()
  const price = radar.config.pricePerMinute
  const n = (x: number) => grouped(x, t.savings.thousands)
  const nameW = Math.max(4, ...sv.perRepo.map(r => r.repo.length))
  const levelMark: Record<Level, string> = { ok: '·', warn: '⚠', bad: '✖' }
  return {
    text: t.savings.report({
      month: sv.month,
      total: money(sv.monthMinutes, price),
      minutes: n(sv.monthMinutes),
      today: money(sv.todayMinutes, price),
      todayMinutes: n(sv.todayMinutes),
      perRepo:
        sv.perRepo.length > 0
          ? sv.perRepo.map(r => `  ${r.repo.padEnd(nameW)}  ${money(r.minutes, price).padStart(8)}  ${n(r.minutes)} min`)
          : [t.savings.none],
      hosted: sv.hostedMinutes > 0 ? t.savings.hosted(n(sv.hostedMinutes)) : '',
      price: `$${price}`,
      status: savingsStatus(sv, now, t).map(x => `${levelMark[x.level]} ${x.text}`),
      from: sv.historyFrom,
    }),
  }
}

const FENCE = '```'

/** `/radar logs <repo>`: the log tail of the failed steps of the repo's latest run. */
async function showLogs($: EngineInterface, radar: Radar, repo: string | undefined): Promise<{ text: string }> {
  const t = textOf(radar)
  if (!repo) return { text: t.cmd.logsUsage }
  const s = await read($, snapshot)
  const summary = s?.repos.find(r => r.repo.toLowerCase() === repo.toLowerCase())
  if (!s || !summary) return { text: t.cmd.logsNoRepo(repo) }
  if (summary.error) return { text: t.cmd.logsUnavailable(summary.repo, explain(summary.error, t)) }
  const failure = summary.failure
  if (!failure) return { text: t.cmd.logsNoFailure(summary.repo) }
  const header = t.cmd.logsHeader(summary.repo, failure.workflow, failure.branch, failure.url)
  const lines = await failedLog(caller($, radar.limiter), s.owner, summary.repo, failure.runId, 40)
  if (typeof lines === 'string') return { text: `${header}\n\n${lines}` }
  if (lines.length === 0) return { text: `${header}\n\n${t.cmd.logsEmpty}` }
  return { text: [header, '', FENCE, ...lines, FENCE].join('\n') }
}

async function runCommand($: EngineInterface, radar: Radar, args: string): Promise<{ text: string }> {
  const words = args.split(/\s+/).filter(Boolean)
  if (words[0] && /^(logs|errors|errores)$/i.test(words[0])) return showLogs($, radar, words[1])
  if (words[0] && /^(savings|ahorro|cost|coste)$/i.test(words[0])) return showSavings($, radar)
  if (words.some(w => /^(off|stop)$/i.test(w))) {
    stop(radar)
    await update($, polling, () => false)
    $.ui.status(undefined)
    await $.ui.close({ id: PANE })
    return { text: textOf(radar).cmd.stopped }
  }
  for (const w of words) {
    if (/^(es|en)$/i.test(w)) radar.langOverride = parseLang(w)
    else if (/^refresh$/i.test(w)) continue
    else if (/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(w)) {
      if (w.toLowerCase() !== ownerOf(radar).toLowerCase()) endSavingsGeneration(radar)
      radar.ownerOverride = w
    } else return { text: textOf(radar).cmd.badOwner(w) }
  }
  const t = textOf(radar)
  const who = ownerOf(radar)
  if (!who) return { text: t.cmd.needOwner }

  await update($, polling, () => true)
  start($, radar)
  const opened = await $.ui.open({ id: PANE, title: `Runner Radar · ${who}` })
  // A language switch redraws the pane right away from what we already have.
  $.ui.invalidate('ui.render')
  kick($, radar)
  return { text: opened.isPlaced ? t.cmd.watching(who, seconds(radar)) : t.cmd.watchingNarrow(who, seconds(radar)) }
}

export const register: Register = (on, options) => {
  const radar: Radar = {
    config: readConfig(options),
    timer: undefined,
    inFlight: false,
    refreshing: undefined,
    ownerOverride: '',
    langOverride: undefined,
    kinds: new Map(),
    memory: freshMemory(),
    limiter: freshLimiter(),
    failureCache: new Map(),
    savingsTimer: undefined,
    savingsSoon: undefined,
    savingsPass: undefined,
    savingsGen: 0,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Live radar of your self-hosted GitHub Actions runners (/radar <owner>, /radar savings, /radar es|en, /radar off)',
    })
    // A reload dropped the module's timer: pick polling back up if it was on.
    if (await read($, polling)) {
      start($, radar)
      kick($, radar)
    }
    return next(e)
  })

  // The registration's .catch also covers a hook that overruns its budget,
  // which a try/catch inside it cannot.
  on('command.run', { command: COMMAND }, async ($, e) => runCommand($, radar, e.args.trim())).catch(() => ({
    text: textOf(radar).cmd.failed,
  }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => renderPane($, e, radar))
}

// ── The pane ────────────────────────────────────────────────────

const LEVEL_COLOR: Record<Level, string> = { ok: 'green', warn: 'yellow', bad: 'red' }
const LEVEL_ICON: Record<Level, string> = { ok: '✔', warn: '⚠', bad: '✖' }

/** Width of the last-results column: the repo scan keeps the 5 latest runs. */
const RECENT = 5

const pad = (text: string, n: number) => (text.length >= n ? text : text + ' '.repeat(n - text.length))

type Elements = ReturnType<EngineInterface['ui']['resolve']>

/**
 * The hosted-equivalent section: the month's estimate first, then today, the
 * top repos, what the figures cover (incomplete, paused, failed, stale), and
 * the basis with its caveats.
 */
function renderSavings(
  Box: Elements['Box'],
  Text: Elements['Text'],
  sv: Savings,
  t: Strings,
  width: number,
  mode: 'full' | 'compact' | 'summary',
  now: number,
) {
  const price = sv.pricePerMinute
  const n = (x: number) => grouped(x, t.savings.thousands)
  const top = sv.perRepo.slice(0, mode === 'full' ? 3 : 0)
  const status = savingsStatus(sv, now, t)
  return (
    <Box flexDirection="column">
      <Box marginTop={1}>
        <Text>
          <Text bold>{t.savings.title}</Text>
          <Text dimColor>{cut(`  ${t.savings.summary}`, Math.max(1, width - t.savings.title.length))}</Text>
        </Text>
      </Box>
      {sv.monthMinutes === 0 && sv.coverage === 'complete' && <Text dimColor>{cut(`  ${t.savings.none}`, width)}</Text>}
      {(sv.monthMinutes > 0 || sv.coverage !== 'complete') && (
        <Text bold>{cut(`  ${t.savings.total(money(sv.monthMinutes, price), n(sv.monthMinutes))}`, width)}</Text>
      )}
      {sv.monthMinutes > 0 && (
        <Text dimColor>{cut(`     ${t.savings.today(money(sv.todayMinutes, price), n(sv.todayMinutes))}`, width)}</Text>
      )}
      {top.length > 0 && (
        <Text dimColor>
          {cut(`     ${top.map(r => `${r.repo} ${money(r.minutes, price)}`).join(' · ')}`, width)}
        </Text>
      )}
      {status.map(x =>
        x.level === 'ok' ? (
          <Text dimColor>{cut(`     ${x.text}`, width)}</Text>
        ) : (
          <Text color={LEVEL_COLOR[x.level]}>{cut(`     ${x.text}`, width)}</Text>
        ),
      )}
      <Text dimColor>{cut(`     ${t.savings.caveat}`, width)}</Text>
      <Text dimColor>{cut(`     ${t.savings.price(`$${price}`)}`, width)}</Text>
    </Box>
  )
}

async function renderPane($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], radar: Radar) {
  const { Box, Text, Link } = $.ui.resolve(e)
  const t = textOf(radar)
  const s = await read($, snapshot)
  if (!s) return <Text dimColor>{t.asking}</Text>

  const config = radar.config
  const columns = (e as { viewport?: { columns?: number } }).viewport?.columns ?? 76
  const width = Math.max(1, columns - 4)
  const mode = layout(width)
  const now = s.updatedAt
  const head = headline(s, now, config, t)
  const busyWith = assignments(s)
  const waiting = queue(s)
  const online = s.runners.filter(r => r.online).length
  const working = s.runners.filter(r => r.busy).length
  const nameW = Math.min(20, Math.max(6, ...s.runners.map(r => r.name.length)))
  const stateW = Math.max(t.state.free.length, t.state.working.length, t.state.offline.length)
  const isActive = (r: RepoSummary) => Boolean(r.running || r.queued || r.unscheduled || r.error)
  const active = s.repos.filter(isActive)
  const quiet = s.repos.filter(r => !isActive(r))
  const repoW = Math.min(28, Math.max(4, ...s.repos.map(r => r.repo.length)))
  const clock = await $.clock.now()
  const stale = clock - s.updatedAt > config.intervalMs * 2.5
  const partial = partialWarning(s, t)
  const sv = config.savingsOn ? await read($, savingsAtom) : null

  const section = (title: string, summary: string) => (
    <Box marginTop={1}>
      <Text>
        <Text bold>{title}</Text>
        <Text dimColor>{`  ${summary}`}</Text>
      </Text>
    </Box>
  )

  return (
    <Box flexDirection="column">
      {/* The answer first: is anything wrong? */}
      <Text color={LEVEL_COLOR[head.level]} bold>
        {cut(`${LEVEL_ICON[head.level]} ${head.text}`, width)}
      </Text>

      {mode === 'summary' && <Text dimColor>{cut(t.narrow(columns), width)}</Text>}
      {partial && <Text color="yellow">{cut(partial, width)}</Text>}

      {mode !== 'summary' && <>

      {section(t.runnersTitle, t.runnersSummary(online, s.runners.length, working))}
      {s.runners.length === 0 && <Text dimColor>{cut(`  ${s.error ? explain(s.error, t) : t.noRunners(s.owner)}`, width)}</Text>}
      {s.runners.length > 0 && s.error && <Text color="yellow">{cut(`  ${explain(s.error, t)}`, width)}</Text>}
      {s.runners.map(r => {
        const job = busyWith.get(r.name)
        const level: Level = !r.online ? 'bad' : r.busy ? 'warn' : 'ok'
        const state = !r.online ? t.state.offline : r.busy ? t.state.working : t.state.free
        const used = 4 + nameW + 2 + stateW + 2
        return (
          <Text>
            <Text color={LEVEL_COLOR[level]}>{'  ● '}</Text>
            <Text>{pad(cut(r.name, nameW), nameW)}</Text>
            <Text color={LEVEL_COLOR[level]}>{`  ${pad(state, stateW)}`}</Text>
            {job && (
              <Text dimColor>{`  ${cut(`${job.repo} › ${job.name}`, width - used - 10)}  ${duration(now - job.startedAt)}`}</Text>
            )}
          </Text>
        )
      })}

      {section(t.queueTitle, t.queueSummary(waiting.length))}
      {waiting.slice(0, 8).map(j => {
        const wait = now - j.createdAt
        const why = reasonFor(j, s, t)
        const what = cut(`${j.repo} › ${j.name}`, mode === 'compact' ? Math.max(8, width - 16) : Math.max(12, Math.floor(width * 0.4)))
        if (mode === 'compact') return (
          <Box flexDirection="column">
            <Text>
              <Text color={LEVEL_COLOR[waitLevel(wait, config.waitAlertMinutes)]} bold>{`  ${duration(wait).padStart(6)}`}</Text>
              <Text>{`  ${what}`}</Text>
            </Text>
            {why && <Text color={why.blocking ? 'red' : 'gray'}>{cut(`    · ${why.text}`, width)}</Text>}
          </Box>
        )
        return (
          <Text>
            <Text color={LEVEL_COLOR[waitLevel(wait, config.waitAlertMinutes)]} bold>
              {`  ${duration(wait).padStart(6)}`}
            </Text>
            <Text>{`  ${what}`}</Text>
            {why && <Text color={why.blocking ? 'red' : 'gray'}>{cut(`  · ${why.text}`, width - what.length - 10)}</Text>}
          </Text>
        )
      })}
      {waiting.length > 8 && <Text dimColor>{`  ${t.andMore(waiting.length - 8)}`}</Text>}

      {section(t.reposTitle, `${t.reposSummary(s.repos.length)} · ${t.lastRuns}`)}
      {[...active, ...quiet].map(r => {
        const last = r.recent[0]
        const busy = r.running || r.queued || r.unscheduled
        const dot = r.error ? 'red' : busy ? 'yellow' : last ? mark(last).color : 'gray'
        // Jobs running or waiting, then runs GitHub has not created jobs for yet.
        const parts = [
          r.running || r.queued ? t.repoRow(r.running, r.queued) : '',
          r.unscheduled ? t.repoUnscheduled(r.unscheduled, duration(now - r.unscheduledSince)) : '',
        ].filter(Boolean)
        const activity = parts.length ? parts.join(' · ') : t.repoQuiet
        const f = r.failure
        const where = f?.jobs[0] ? t.failedAt(f.jobs[0].name, f.jobs[0].step) : ''
        return (
          <Box flexDirection="column">
            {/* Fixed-width columns first (name, last 5 results), the variable text last,
                so nothing after it can shift out of line. */}
            <Text>
              <Text color={dot}>{'  ● '}</Text>
              <Text>{pad(cut(r.repo, repoW), repoW)}</Text>
              <Text>{'  '}</Text>
              {r.recent.map(c => {
                const m = mark(c)
                return <Text color={m.color}>{m.glyph}</Text>
              })}
              <Text>{' '.repeat(RECENT - r.recent.length)}</Text>
              <Text dimColor={!busy}>{cut(`  ${activity}`, width - repoW - RECENT - 6)}</Text>
              {r.error && <Text color="red">{cut(`  ${explain(r.error, t)}`, width - repoW - RECENT - activity.length - 8)}</Text>}
            </Text>
            {/* What failed and where, with a way to read the error. */}
            {f && (
              <Text color="red">{cut(`      ${t.failure(f.workflow, f.branch, duration(now - f.at), where)}`, width)}</Text>
            )}
            {f && f.jobs.length > 1 && <Text dimColor>{cut(`        +${f.jobs.length - 1}: ${f.jobs.slice(1).map(j => j.name).join(', ')}`, width)}</Text>}
            {f && (
              <Text dimColor>
                {'        '}
                <Link href={f.jobs[0]?.url || f.url} label={t.viewOnGitHub} />
                {`  ·  ${t.logsHint(r.repo)}`}
              </Text>
            )}
          </Box>
        )
      })}
      {sv && sv.owner === s.owner && renderSavings(Box, Text, sv, t, width, mode, clock)}
      </>}

      <Box marginTop={1}>
        <Text dimColor>
          {stale && <Text color="yellow">{t.stale}</Text>}
          {t.updated(new Date(s.updatedAt).toTimeString().slice(0, 8), seconds(radar))}
        </Text>
      </Box>
    </Box>
  )
}
