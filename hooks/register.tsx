import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { ApiError, FailedJob, Savings, Snapshot } from '../types'
import { completedRuns, failedLog, listRepos, listRunners, ownerKind, runMinutes, scanRepo } from './github'
import {
  DEFAULT_PRICE_PER_MINUTE,
  dayKey,
  grouped,
  money,
  monthKey,
  readMonth,
  storeKey,
  summarize,
} from './savings'
import { type Lang, parseLang, type Strings, strings } from './i18n'
import {
  type AlertMemory,
  alerts,
  assignments,
  apiError,
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
//   /radar refresh    refresh now        /radar off    stop

const PANE = 'runner-radar'
const COMMAND = 'radar'

// Bump a shape tag when its value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const snapshot = atom({ plugin: 'runner-radar', key: 'snapshot' } as const, null, { shape: 'snapshot-3' })
const polling = atom({ plugin: 'runner-radar', key: 'polling' } as const, false, { shape: 'polling-1' })
const savingsAtom = atom({ plugin: 'runner-radar', key: 'savings' } as const, null, { shape: 'savings-1' })

/** A savings pass runs this often: minutes of finished runs don't change. */
const SAVINGS_EVERY_MS = 5 * 60_000
/** While runs are left to count, the next pass comes this soon. */
const SAVINGS_CATCH_UP_MS = 60_000
/** Runs looked up per pass: the first month's backlog fills in over a few passes. */
const SAVINGS_RUNS_PER_PASS = 25

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
  ownerOverride: string
  langOverride: Lang | undefined
  kinds: Map<string, 'org' | 'user'>
  memory: AlertMemory
  /** Avoid hammering GitHub after it reports primary or secondary rate limiting. */
  rateLimitUntil: number
  /** Failed jobs per run id: a failed run is looked up once. */
  failureCache: Map<number, FailedJob[]>
  savingsTimer: Timer | undefined
  savingsSoon: Timer | undefined
  savingsInFlight: boolean
}

const ownerOf = (radar: Radar): string => radar.ownerOverride || radar.config.owner
const textOf = (radar: Radar): Strings => strings(radar.langOverride ?? radar.config.lang)
const seconds = (radar: Radar): number => radar.config.intervalMs / 1000

async function refresh($: EngineInterface, radar: Radar): Promise<void> {
  const who = ownerOf(radar)
  if (!who || radar.inFlight) return
  radar.inFlight = true
  const empty = async (error: string): Promise<Snapshot> => ({
    owner: who,
    updatedAt: await $.clock.now(),
    runners: [],
    jobs: [],
    repos: [],
    error: apiError(error),
    runnerErrors: [],
  })
  const publishError = async (error: string): Promise<Snapshot> => {
    const next = await empty(error)
    await publish($, radar, next)
    radar.rateLimitUntil = hasRateLimit(next) ? next.updatedAt + 60_000 : 0
    return next
  }
  try {
    if ((await $.clock.now()) < radar.rateLimitUntil) return
    let kind = radar.kinds.get(who)
    if (!kind) {
      const k = await ownerKind($, who)
      if (k !== 'org' && k !== 'user') return void (await publishError(k))
      kind = k
      radar.kinds.set(who, k)
    }
    const repos = await listRepos($, who, kind, radar.config.repos, radar.config.maxRepos)
    if (typeof repos === 'string') return void (await publishError(repos))
    const [fleet, scans] = await Promise.all([
      listRunners($, who, kind, repos),
      Promise.all(repos.map(repo => scanRepo($, who, repo, radar.failureCache))),
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
    radar.rateLimitUntil = hasRateLimit(next) ? next.updatedAt + 60_000 : 0
    // First data for this owner: count savings now instead of in five minutes.
    const sv = await read($, savingsAtom)
    if (radar.config.savingsOn && (!sv || sv.owner !== who)) kickSavings($, radar)
  } catch (err) {
    // A refresh runs unawaited from a timer: surface the failure in the pane.
    await publishError(err instanceof Error ? err.message : String(err))
  } finally {
    radar.inFlight = false
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

/**
 * One savings pass: list this month's completed runs of the watched repos, look
 * up the billable minutes of runs not counted yet (a bounded number per pass),
 * keep them in `$.store` by run id, and publish the month's totals.
 */
async function refreshSavings($: EngineInterface, radar: Radar): Promise<void> {
  if (!radar.config.savingsOn || radar.savingsInFlight) return
  const who = ownerOf(radar)
  const s = await read($, snapshot)
  if (!who || !s || s.owner !== who || s.repos.length === 0) return
  if ((await $.clock.now()) < radar.rateLimitUntil) return
  radar.savingsInFlight = true
  try {
    const now = await $.clock.now()
    const month = monthKey(now)
    const key = storeKey(who, month)
    const usage = readMonth(await $.store.get(key))
    let error: ApiError | undefined
    const pending: Array<{ repo: string; id: number; day: string }> = []
    for (const repo of s.repos.map(r => r.repo)) {
      const listed = await completedRuns($, who, repo, `${month}-01`)
      if (listed.error) error ??= listed.error
      for (const run of listed.runs) {
        if (!usage[String(run.id)]) pending.push({ repo, id: run.id, day: dayKey(Date.parse(run.created_at) || now) })
      }
    }
    let counted = 0
    for (const p of pending.slice(0, SAVINGS_RUNS_PER_PASS)) {
      const m = await runMinutes($, who, p.repo, p.id)
      if ('error' in m) {
        error ??= m.error
        if (m.error.kind === 'rateLimit') break
        continue
      }
      usage[String(p.id)] = [p.repo, p.day, m.selfHosted, m.hosted]
      counted++
    }
    if (counted > 0) {
      await $.store.set(key, usage)
      await forgetOldMonths($, who, month)
    }
    const result = summarize(usage, {
      owner: who,
      month,
      today: dayKey(now),
      pricePerMinute: radar.config.pricePerMinute,
      runsPending: pending.length - counted,
      updatedAt: now,
      error,
    })
    await update($, savingsAtom, () => result)
    if (error?.kind === 'rateLimit') radar.rateLimitUntil = now + 60_000
    // Runs left to count: come back soon instead of waiting for the next pass.
    else if (result.runsPending > 0 && counted > 0 && !radar.savingsSoon) {
      radar.savingsSoon = $.clock.after(SAVINGS_CATCH_UP_MS, () => {
        radar.savingsSoon = undefined
        kickSavings($, radar)
      })
    }
  } finally {
    radar.savingsInFlight = false
  }
}

/** Keeps the current and the previous month of an owner; older months are dropped. */
async function forgetOldMonths($: EngineInterface, owner: string, month: string): Promise<void> {
  const prefix = storeKey(owner, '')
  const [y, m] = month.split('-').map(Number)
  const previous = m === 1 ? `${(y ?? 0) - 1}-12` : `${y}-${String((m ?? 1) - 1).padStart(2, '0')}`
  for (const key of await $.store.keys()) {
    if (key.startsWith(prefix) && key !== storeKey(owner, month) && key !== storeKey(owner, previous)) {
      await $.store.delete(key)
    }
  }
}

function kickSavings($: EngineInterface, radar: Radar): void {
  refreshSavings($, radar).catch(() => undefined)
}

function start($: EngineInterface, radar: Radar): void {
  if (radar.timer) return
  radar.timer = $.clock.every(radar.config.intervalMs, () => kick($, radar))
  if (radar.config.savingsOn) radar.savingsTimer = $.clock.every(SAVINGS_EVERY_MS, () => kickSavings($, radar))
}

function stop(radar: Radar): void {
  radar.timer?.cancel()
  radar.timer = undefined
  radar.savingsTimer?.cancel()
  radar.savingsTimer = undefined
  radar.savingsSoon?.cancel()
  radar.savingsSoon = undefined
}

/** `/radar savings`: the month's savings in the conversation, with the assumptions. */
async function showSavings($: EngineInterface, radar: Radar): Promise<{ text: string }> {
  const t = textOf(radar)
  if (!radar.config.savingsOn) return { text: t.savings.off }
  await refreshSavings($, radar)
  const sv = await read($, savingsAtom)
  if (!sv) return { text: t.cmd.needOwner }
  const price = radar.config.pricePerMinute
  const n = (x: number) => grouped(x, t.savings.thousands)
  const nameW = Math.max(4, ...sv.perRepo.map(r => r.repo.length))
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
      counting: sv.runsPending > 0 ? t.savings.counting(sv.runsCounted, sv.runsCounted + sv.runsPending) : '',
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
  const lines = await failedLog($, s.owner, summary.repo, failure.runId, 40)
  if (typeof lines === 'string') return { text: `${header}\n\n${lines}` }
  if (lines.length === 0) return { text: `${header}\n\n${t.cmd.logsEmpty}` }
  return { text: [header, '', FENCE, ...lines, FENCE].join('\n') }
}

async function runCommand($: EngineInterface, radar: Radar, args: string): Promise<{ text: string }> {
  const words = args.split(/\s+/).filter(Boolean)
  if (words[0] && /^(logs|errors|errores)$/i.test(words[0])) return showLogs($, radar, words[1])
  if (words[0] && /^(savings|ahorro)$/i.test(words[0])) return showSavings($, radar)
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
    else if (/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(w)) radar.ownerOverride = w
    else return { text: textOf(radar).cmd.badOwner(w) }
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
    ownerOverride: '',
    langOverride: undefined,
    kinds: new Map(),
    memory: freshMemory(),
    rateLimitUntil: 0,
    failureCache: new Map(),
    savingsTimer: undefined,
    savingsSoon: undefined,
    savingsInFlight: false,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Live radar of your self-hosted GitHub Actions runners (/radar <owner>, /radar es|en, /radar off)',
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

/** The savings section: month total first, then today, the top repos, and the basis. */
function renderSavings(
  Box: Elements['Box'],
  Text: Elements['Text'],
  sv: Savings,
  t: Strings,
  width: number,
  mode: 'full' | 'compact' | 'summary',
) {
  const price = sv.pricePerMinute
  const n = (x: number) => grouped(x, t.savings.thousands)
  const top = sv.perRepo.slice(0, mode === 'full' ? 3 : 0)
  const counting = sv.runsPending > 0 ? t.savings.counting(sv.runsCounted, sv.runsCounted + sv.runsPending) : ''
  return (
    <Box flexDirection="column">
      <Box marginTop={1}>
        <Text>
          <Text bold>{t.savings.title}</Text>
          <Text dimColor>{cut(`  ${t.savings.summary}`, Math.max(1, width - t.savings.title.length))}</Text>
        </Text>
      </Box>
      {sv.monthMinutes === 0 && !counting && <Text dimColor>{cut(`  ${t.savings.none}`, width)}</Text>}
      {(sv.monthMinutes > 0 || counting) && (
        <Text color="green" bold>
          {cut(`  ${t.savings.total(money(sv.monthMinutes, price), n(sv.monthMinutes))}`, width)}
        </Text>
      )}
      {sv.monthMinutes > 0 && (
        <Text dimColor>{cut(`     ${t.savings.today(money(sv.todayMinutes, price), n(sv.todayMinutes))}`, width)}</Text>
      )}
      {top.length > 0 && (
        <Text dimColor>
          {cut(`     ${top.map(r => `${r.repo} ${money(r.minutes, price)}`).join(' · ')}`, width)}
        </Text>
      )}
      {counting && <Text color="yellow">{cut(`     ${counting}`, width)}</Text>}
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
  const active = s.repos.filter(r => r.running || r.queued || r.error)
  const quiet = s.repos.filter(r => !r.running && !r.queued && !r.error)
  const repoW = Math.min(28, Math.max(4, ...s.repos.map(r => r.repo.length)))
  const stale = (await $.clock.now()) - s.updatedAt > config.intervalMs * 2.5
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
        const dot = r.error ? 'red' : r.running || r.queued ? 'yellow' : last ? mark(last).color : 'gray'
        const activity = r.running || r.queued ? t.repoRow(r.running, r.queued) : t.repoQuiet
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
              <Text dimColor={!r.running && !r.queued}>{cut(`  ${activity}`, width - repoW - RECENT - 6)}</Text>
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
      {sv && sv.owner === s.owner && renderSavings(Box, Text, sv, t, width, mode)}
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
