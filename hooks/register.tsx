import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { FailedJob, Snapshot } from '../types'
import { failedLog, listRepos, listRunners, ownerKind, scanRepo } from './github'
import { type Lang, parseLang, type Strings, strings } from './i18n'
import {
  type AlertMemory,
  alerts,
  assignments,
  duration,
  freshMemory,
  headline,
  type Level,
  mark,
  parseRepos,
  queue,
  statusLine,
  waitLevel,
  waitReason,
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
const snapshot = atom({ plugin: 'runner-radar', key: 'snapshot' } as const, null, { shape: 'snapshot-2' })
const polling = atom({ plugin: 'runner-radar', key: 'polling' } as const, false, { shape: 'polling-1' })

type Config = {
  owner: string
  repos: string[]
  maxRepos: number
  intervalMs: number
  queueAlert: number
  waitAlertMinutes: number
  lang: Lang
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
  /** Failed jobs per run id: a failed run is looked up once. */
  failureCache: Map<number, FailedJob[]>
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
    error,
  })
  try {
    let kind = radar.kinds.get(who)
    if (!kind) {
      const k = await ownerKind($, who)
      if (k !== 'org' && k !== 'user') return await publish($, radar, await empty(k))
      kind = k
      radar.kinds.set(who, k)
    }
    const repos = await listRepos($, who, kind, radar.config.repos, radar.config.maxRepos)
    if (typeof repos === 'string') return await publish($, radar, await empty(repos))
    const [fleet, scans] = await Promise.all([
      listRunners($, who, kind, repos),
      Promise.all(repos.map(repo => scanRepo($, who, repo, radar.failureCache))),
    ])
    await publish($, radar, {
      owner: who,
      updatedAt: await $.clock.now(),
      runners: fleet.runners,
      jobs: scans.flatMap(s => s.jobs),
      repos: scans.map(s => s.summary),
      error: fleet.error,
    })
  } catch (err) {
    // A refresh runs unawaited from a timer: surface the failure in the pane.
    await publish($, radar, await empty(err instanceof Error ? err.message : String(err)))
  } finally {
    radar.inFlight = false
  }
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

function start($: EngineInterface, radar: Radar): void {
  if (radar.timer) return
  radar.timer = $.clock.every(radar.config.intervalMs, () => kick($, radar))
}

function stop(radar: Radar): void {
  radar.timer?.cancel()
  radar.timer = undefined
}

const FENCE = '```'

/** `/radar logs <repo>`: the log tail of the failed steps of the repo's latest run. */
async function showLogs($: EngineInterface, radar: Radar, repo: string | undefined): Promise<{ text: string }> {
  const t = textOf(radar)
  if (!repo) return { text: t.cmd.logsUsage }
  const s = await read($, snapshot)
  const summary = s?.repos.find(r => r.repo.toLowerCase() === repo.toLowerCase())
  if (!s || !summary) return { text: t.cmd.logsNoRepo(repo) }
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
    failureCache: new Map(),
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

async function renderPane($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], radar: Radar) {
  const { Box, Text, Link } = $.ui.resolve(e)
  const t = textOf(radar)
  const s = await read($, snapshot)
  if (!s) return <Text dimColor>{t.asking}</Text>

  const config = radar.config
  const width = Math.max(40, ((e as { viewport?: { columns?: number } }).viewport?.columns ?? 72) - 4)
  const cut = (text: string, max: number) => (max <= 1 ? '' : text.length > max ? text.slice(0, max - 1) + '…' : text)
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

      {section(t.runnersTitle, t.runnersSummary(online, s.runners.length, working))}
      {s.runners.length === 0 && <Text dimColor>{cut(`  ${s.error ?? t.noRunners(s.owner)}`, width)}</Text>}
      {s.runners.length > 0 && s.error && <Text color="yellow">{cut(`  ${s.error}`, width)}</Text>}
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
        const why = s.error ? undefined : waitReason(j, s.runners, t)
        const what = cut(`${j.repo} › ${j.name}`, Math.max(12, Math.floor(width * 0.4)))
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
              {r.error && <Text color="red">{cut(`  ${r.error}`, width - repoW - RECENT - activity.length - 8)}</Text>}
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

      <Box marginTop={1}>
        <Text dimColor>
          {stale && <Text color="yellow">{t.stale}</Text>}
          {t.updated(new Date(s.updatedAt).toTimeString().slice(0, 8), seconds(radar))}
        </Text>
      </Box>
    </Box>
  )
}
